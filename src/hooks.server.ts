import type { Handle, ServerInit } from "@sveltejs/kit";

import { createHeaderAuthUser, getUserByDiscordId } from "@/lib/server/auth/auth";
import {
	AUTH_BASE_PATH,
	auth,
	getAuthSession,
	getDiscordAccessToken,
	isAuthEnabled
} from "@/lib/server/auth/betterAuth";
import TTLCache from "@isaacs/ttlcache";
import {
	getEveryonePerms,
	getPermsFromRoleIds,
	updatePermissions
} from "@/lib/server/auth/permissions";
import type { User } from "@/lib/server/db/internal/schema";
import { PERMISSION_UPDATE_INTERVAL } from "@/lib/constants";
import type { Perms } from "@/lib/utils/features";
import { locales, serverAsyncLocalStorage } from "@/lib/paraglide/runtime";
import { paraglideMiddleware } from "@/lib/paraglide/server";
import { sequence } from "@sveltejs/kit/hooks";
import { setServerLoggerFactory } from "@/lib/utils/logger";
import { getServerLogger } from "@/lib/server/logging";
import { getClientConfig, getServerConfig } from "@/lib/services/config/config.server";
import { setConfig } from "@/lib/services/config/config";
import { getDisallowedPaths } from "@/lib/utils/disallowedPaths";
import { timingSafeEqual } from "node:crypto";

process.title = "Diadem";

const paraglideHandle: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request: localizedRequest, locale }) => {
		event.request = localizedRequest;

		// set locale for ssr metadata
		const langParam = event.url.searchParams.get("lang");
		const isValidLang = !!langParam && (locales as readonly string[]).includes(langParam);
		if (isValidLang) {
			const store = serverAsyncLocalStorage?.getStore();
			if (store) store.locale = langParam as (typeof locales)[number];
		}
		// Use the validated lang only — `effectiveLocale` is interpolated into
		// `<html lang="%lang%">` so any unvalidated value is reflected XSS.
		const effectiveLocale = isValidLang ? langParam! : locale;

		return resolve(event, {
			transformPageChunk: ({ html }) => html.replace("%lang%", effectiveLocale)
		});
	});

const permissionCache: TTLCache<string, Perms> = new TTLCache({
	ttl: PERMISSION_UPDATE_INTERVAL * 1000
});
const authLog = getServerLogger("auth");
const permissionUpdateInFlight = new Map<string, Promise<Perms>>();

const publicRoutePrefixes = ["/api/locale/", "/assets/"];
const publicRoutes = new Set(["/api/config", "/api/pogodata", "/api/koji", "/api/stats"]);

function isPublicRoute(pathname: string) {
	return (
		publicRoutes.has(pathname) || publicRoutePrefixes.some((prefix) => pathname.startsWith(prefix))
	);
}

function updatePermissionsLocked(user: User, accessToken: string, thisFetch: typeof fetch) {
	let updatePromise = permissionUpdateInFlight.get(user.id);
	if (!updatePromise) {
		updatePromise = updatePermissions(user, accessToken, thisFetch).finally(() => {
			permissionUpdateInFlight.delete(user.id);
		});
		permissionUpdateInFlight.set(user.id, updatePromise);
	}
	return updatePromise;
}

// Perms keyed by user + forwarded role set, so a gateway user's permissions
// refresh on the same interval as cookie-auth users without a per-request DB hit.
const headerPermsCache: TTLCache<string, Perms> = new TTLCache({
	ttl: PERMISSION_UPDATE_INTERVAL * 1000,
	max: 10_000
});

// Discord snowflake IDs are 17–20 digits; allow a small margin of safety.
const DISCORD_ID_RE = /^\d{1,25}$/;

// Constant-time compare for arbitrary-length strings. The length check leaks
// secret length but is required because `timingSafeEqual` rejects unequal
// lengths. Acceptable trade-off for a shared-secret header.
function timingSafeStringEq(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

function deepFreeze<T>(obj: T): T {
	if (obj && typeof obj === "object") {
		for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
		Object.freeze(obj);
	}
	return obj;
}

function splitCsv(v: string | null): string[] {
	return (v ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// Resolve (or lazily create) the DB user row for a gateway-authenticated
// Discord id. Tolerates the create racing another request for the same id.
async function resolveHeaderUser(discordId: string, displayName: string): Promise<User | null> {
	const existing = await getUserByDiscordId(discordId);
	if (existing) return existing;
	try {
		await createHeaderAuthUser(discordId, displayName);
	} catch (e) {
		const code = (e as { code?: string; errno?: number }).code;
		const errno = (e as { code?: string; errno?: number }).errno;
		if (code !== "ER_DUP_ENTRY" && errno !== 1062) {
			authLog.error(`Header auth: failed to create user ${discordId}: ${e}`);
			throw e;
		}
	}
	return getUserByDiscordId(discordId);
}

const handleAuth: Handle = async ({ event, resolve }) => {
	if (process.env.BUILD_TARGET === "native") {
		event.locals.perms = { everywhere: [], areas: [] };
		event.locals.user = null;
		event.locals.session = null;
		event.locals.authSource = null;
		event.locals.headerProfile = null;
		return resolve(event);
	}

	if (auth && event.url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
		return auth.handler(event.request);
	}

	// These endpoints never use request-specific permissions. Avoid a session, database,
	// and Koji lookup so they remain safe and useful CDN cache candidates.
	if (isPublicRoute(event.url.pathname)) {
		event.locals.perms = { everywhere: [], areas: [] };
		event.locals.user = null;
		event.locals.session = null;
		return resolve(event);
	}

	event.locals.perms = await getEveryonePerms(event.fetch);
	event.locals.user = null;
	event.locals.session = null;
	event.locals.authSource = null;
	event.locals.headerProfile = null;

	// Upstream-gateway auth (e.g. nginx auth_request). When enabled and
	// `X-User-ID` is present, build user/perms from forwarded headers and skip
	// the Discord session path. Diadem must be bound to 127.0.0.1 so direct
	// requests cannot spoof these headers.
	const headerAuthCfg = getServerConfig().auth.headerAuth;
	const headerUserId = headerAuthCfg?.enabled ? event.request.headers.get("x-user-id") : null;
	if (headerAuthCfg?.enabled && headerUserId) {
		if (!DISCORD_ID_RE.test(headerUserId)) {
			authLog.warning(
				`Header auth: rejecting malformed X-User-ID (len=${headerUserId.length}), falling back to cookie path`
			);
		} else {
			// Optional shared-secret defense in depth. If a secret is configured
			// the gateway must forward it; otherwise reject. Empty string is
			// rejected at startup, see init().
			if (
				typeof headerAuthCfg.gatewaySecret === "string" &&
				headerAuthCfg.gatewaySecret.length > 0
			) {
				const got = event.request.headers.get("x-gateway-secret") ?? "";
				if (!timingSafeStringEq(headerAuthCfg.gatewaySecret, got)) {
					return new Response("invalid gateway secret", { status: 401 });
				}
			}

			const headerUsername = event.request.headers.get("x-user-username") ?? "";
			const headerDisplayName = event.request.headers.get("x-user-display-name") ?? "";
			const headerAvatarHash = event.request.headers.get("x-user-avatar-hash") ?? "";
			const headerRoles = splitCsv(event.request.headers.get("x-user-roles"));
			const headerRoleIds = splitCsv(event.request.headers.get("x-user-role-ids"));
			const displayName = headerDisplayName || headerUsername || headerUserId;

			const user = await resolveHeaderUser(headerUserId, displayName);
			if (!user) {
				authLog.error(`Header auth: could not resolve user id for ${headerUserId}`);
				return new Response("auth failed", { status: 500 });
			}

			// Discord role IDs are numeric snowflakes — no commas — so joining is safe.
			const cacheKey = `${user.id}|${[...new Set(headerRoleIds)].sort().join(",")}`;
			let perms = headerPermsCache.get(cacheKey);
			if (!perms) {
				perms = deepFreeze(await getPermsFromRoleIds(headerRoleIds, event.fetch));
				headerPermsCache.set(cacheKey, perms);
			}

			const avatarUrl = headerAvatarHash
				? `https://cdn.discordapp.com/avatars/${headerUserId}/${headerAvatarHash}.webp?size=256`
				: "";

			event.locals.user = user;
			event.locals.session = null;
			event.locals.perms = perms;
			event.locals.authSource = "header";
			event.locals.headerProfile = {
				username: headerUsername,
				displayName,
				avatarUrl,
				roles: headerRoles,
				roleIds: headerRoleIds
			};
			return resolve(event);
		}
	}

	// Cookie/Discord session path only runs when Better Auth is configured.
	if (!auth || !isAuthEnabled()) {
		return resolve(event);
	}

	const authSession = await getAuthSession(event);
	if (!authSession?.session || !authSession.user) {
		return resolve(event);
	}

	const discordId = authSession.user.discordId;
	if (!discordId) {
		authLog.warning("Authenticated user has no discordId in Better Auth session");
		return resolve(event);
	}

	const user = await getUserByDiscordId(discordId);
	if (!user) {
		authLog.warning(`No user row found for Discord id ${discordId}`);
		return resolve(event);
	}

	let perms = permissionCache.get(user.id);
	if (!perms) {
		const accessToken = await getDiscordAccessToken(event);
		try {
			perms = await updatePermissionsLocked(user, accessToken ?? "", event.fetch);
			permissionCache.set(user.id, perms);
		} catch (error) {
			authLog.warning(`Failed to update permissions for user ${user.id}: ${error}`);
			perms = event.locals.perms;
		}
	}

	event.locals.user = user;
	event.locals.session = authSession.session;
	event.locals.perms = perms;
	event.locals.authSource = "cookie";
	return resolve(event);
};

export const init: ServerInit = async () => {
	// set config for ssr
	const config = getClientConfig();
	setConfig(config);

	setServerLoggerFactory((name) => {
		const winstonLogger = getServerLogger(name);
		return {
			debug: (message, ...args) => winstonLogger.debug(message, ...args),
			info: (message, ...args) => winstonLogger.info(message, ...args),
			warning: (message, ...args) => winstonLogger.warning(message, ...args),
			error: (message, ...args) => winstonLogger.error(message, ...args),
			crit: (message, ...args) => winstonLogger.crit(message, ...args)
		};
	});

	// Fail fast on a header-auth secret that is present but not a non-empty
	// string. The config is parsed from raw TOML with no schema validation, so a
	// value like `gatewaySecret = 123` (number) or `""` would otherwise pass
	// startup and then silently disable the runtime shared-secret check (which
	// only enforces for non-empty strings) while looking configured.
	const headerAuthCfg = getServerConfig().auth.headerAuth;
	if (
		headerAuthCfg?.enabled &&
		Object.prototype.hasOwnProperty.call(headerAuthCfg, "gatewaySecret") &&
		(typeof headerAuthCfg.gatewaySecret !== "string" || headerAuthCfg.gatewaySecret.length === 0)
	) {
		throw new Error(
			"auth.headerAuth.gatewaySecret is set but empty or not a string; remove it or give it a non-empty string value"
		);
	}

	if (process.env.BUILD_TARGET === "native") return;

	const { initDiadem } = await import("@/lib/server/init");
	await initDiadem();
};

const handleSeo: Handle = async ({ event, resolve }) => {
	const general = getClientConfig().general;

	return resolve(event, {
		transformPageChunk: ({ html }) => {
			const metaTags: string[] = [];

			const addMeta = (identifier: string, tag: string) => {
				if (!html.includes(identifier)) metaTags.push(tag);
			};

			const isNonindexPath = getDisallowedPaths().some((p) => event.url.pathname.startsWith(p));
			if (!general.allowCrawlers) {
				addMeta('name="robots"', '<meta name="robots" content="noindex, nofollow">');
			} else if (isNonindexPath) {
				addMeta('name="robots"', '<meta name="robots" content="noindex, follow">');
			} else {
				addMeta('name="robots"', '<meta name="robots" content="index, follow">');
			}

			if (general.description) {
				addMeta('name="description"', `<meta name="description" content="${general.description}">`);
				addMeta(
					'property="og:description"',
					`<meta property="og:description" content="${general.description}">`
				);
			}
			if (general.image) {
				addMeta('property="og:image"', `<meta property="og:image" content="${general.image}">`);
				addMeta(
					'name="twitter:image:src"',
					`<meta name="twitter:image:src" content="${general.image}">`
				);
				addMeta('name="twitter:card"', '<meta name="twitter:card" content="summary_large_image">');
			}
			if (general.url) {
				addMeta('rel="canonical"', `<link rel="canonical" href="${general.url}">`);
				addMeta('property="og:url"', `<meta property="og:url" content="${general.url}">`);
				if (!general.image) {
					addMeta(
						'property="og:image"',
						`<meta property="og:image" content="${general.url}/thumbnail.png">`
					);
					addMeta(
						'name="twitter:image:src"',
						`<meta name="twitter:image:src" content="${general.url}/thumbnail.png">`
					);
					addMeta(
						'name="twitter:card"',
						'<meta name="twitter:card" content="summary_large_image">'
					);
				}
			}

			addMeta('property="og:title"', `<meta property="og:title" content="${general.mapName}">`);
			addMeta('name="twitter:title"', `<meta name="twitter:title" content="${general.mapName}">`);
			addMeta(
				'property="og:site_name"',
				`<meta property="og:site_name" content="${general.mapName}">`
			);
			addMeta('name="twitter:site"', `<meta name="twitter:site" content="${general.mapName}">`);
			if (general.description) {
				addMeta(
					'name="twitter:description"',
					`<meta name="twitter:description" content="${general.description}">`
				);
			}
			addMeta('property="og:type"', '<meta property="og:type" content="website">');

			if (metaTags.length === 0) return html;
			return html.replace("</head>", metaTags.join("\n") + "\n</head>");
		}
	});
};

export const handle: Handle = sequence(paraglideHandle, handleAuth, handleSeo);
