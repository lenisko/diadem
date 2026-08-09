import { browser } from "$app/environment";
import type {
	FilterGym,
	FilterNest,
	FilterPokemon,
	FilterPokestop,
	FilterRoute,
	FilterS2Cell,
	FilterSpawnpoint,
	FilterStation,
	FilterTappable
} from "@/lib/features/filters/filters";
import { MapObjectType } from "@/lib/mapObjects/mapObjectTypes";
import { getConfig } from "@/lib/services/config/config";
import type { AnySearchEntry } from "@/lib/services/search.svelte";
import { getDefaultMapStyle } from "@/lib/services/themeMode";
import { getUserDetails } from "@/lib/services/user/userDetails.svelte.js";
import { encodeRequestBody, getHeaders } from "@/lib/utils/requests";
import { getDefaultGymFilter } from "@/lib/utils/gymUtils";
import { getDefaultPokestopFilter } from "@/lib/utils/pokestopUtils";
import { getDefaultStationFilter } from "@/lib/utils/stationUtils";

export type UiconSetUS = {
	id: string;
	url: string;
};

export enum ExternalMapProvider {
	GOOGLE = "google",
	APPLE = "apple"
}

type ActionState = {
	expanded: boolean;
	dimmed: {
		mapIds: string[];
	};
	radius: {
		mapIds: string[];
		all: boolean;
		extraRadius: boolean;
	};
	timer: {
		mapIds: string[];
		all: boolean;
	};
};

type LegacyUserSettings = Partial<UserSettings> & {
	expandedMapObjects?: MapObjectType[];
};

export type UserSettings = {
	mapPosition: {
		center: {
			lat: number;
			lng: number;
		};
		zoom: number;
	};
	mapStyle: {
		id: string;
		url: string;
	};
	uiconSet: {
		pokemon: UiconSetUS;
		pokestop: UiconSetUS;
		gym: UiconSetUS;
		station: UiconSetUS;
		tappable: UiconSetUS;
	};
	isLeftHanded: boolean;
	themeMode: "dark" | "light" | "system";
	loadMapObjectsWhileMoving: boolean;
	loadMapObjectsPadding: number;
	showDebugMenu: boolean;
	enableRotatePitch: boolean;
	mapIconSize: number;
	externalMapProvider: ExternalMapProvider;
	filters: {
		pokemon: FilterPokemon;
		pokestop: FilterPokestop;
		gym: FilterGym;
		station: FilterStation;
		s2cell: FilterS2Cell;
		nest: FilterNest;
		spawnpoint: FilterSpawnpoint;
		route: FilterRoute;
		tappable: FilterTappable;
	};
	actions: Record<MapObjectType, ActionState>;
	recentSearches: AnySearchEntry[];
};

function defaultActionState(): ActionState {
	return {
		expanded: false,
		dimmed: {
			mapIds: []
		},
		radius: {
			mapIds: [],
			all: false,
			extraRadius: false
		},
		timer: {
			mapIds: [],
			all: false
		}
	};
}

export function getDefaultUserSettings(): UserSettings {
	const general = getConfig().general;
	const defaultMapStyle = getDefaultMapStyle();

	return {
		mapPosition: {
			center: {
				lat: general.defaultLat ?? 51.516855,
				lng: general.defaultLon ?? -0.0805
			},
			zoom: general.defaultZoom ?? 15
		},
		mapStyle: {
			id: defaultMapStyle.id,
			url: defaultMapStyle.url
		},
		uiconSet: {
			pokemon: getDefaultIconSet(MapObjectType.POKEMON),
			pokestop: getDefaultIconSet(MapObjectType.POKESTOP),
			gym: getDefaultIconSet(MapObjectType.GYM),
			station: getDefaultIconSet(MapObjectType.STATION),
			tappable: getDefaultIconSet(MapObjectType.TAPPABLE)
		},
		isLeftHanded: false,
		themeMode: "system",
		loadMapObjectsWhileMoving: false,
		loadMapObjectsPadding: 20,
		showDebugMenu: false,
		enableRotatePitch: true,
		mapIconSize: 1,
		externalMapProvider: ExternalMapProvider.GOOGLE,
		filters: {
			pokemon: { category: "pokemon", ...defaultFilter() },
			pokestop: getDefaultPokestopFilter(),
			gym: getDefaultGymFilter(),
			station: getDefaultStationFilter(),
			// s2cell: { category: "s2cell", ...defaultFilter() },
			s2cell: {
				category: "s2cell",
				enabled: false,
				level: 14,
				wayfarerMode: false
			},
			nest: { category: "nest", ...defaultFilter() },
			spawnpoint: { category: "spawnpoint", ...defaultFilter() },
			route: { category: "route", ...defaultFilter() },
			tappable: { category: "tappable", ...defaultFilter() }
		},
		actions: Object.fromEntries(
			Object.values(MapObjectType).map((type) => [type, defaultActionState()])
		) as UserSettings["actions"],
		recentSearches: []
	};
}

export function defaultFilter(enabled: boolean = false) {
	return {
		enabled,
		filters: []
	};
}

export function getDefaultIconSet(type: MapObjectType) {
	let iconSet = getConfig().uiconSets.find((s) => typeof s[type] === "object" && s[type]?.default);

	if (!iconSet) {
		iconSet = getConfig().uiconSets.find((s) => s.base?.default);
	}
	if (!iconSet) {
		iconSet = getConfig().uiconSets[0];
	}

	return {
		id: iconSet.id,
		url: iconSet.url
	};
}

// @ts-ignore
let userSettings: UserSettings = $state({});

export async function getUserSettingsFromServer() {
	const response = await fetch("/api/user/settings");
	const dbUserSettings: { error?: string; result: UserSettings } = await response.json();

	// User has existing user settings, merge with defaults and keep the local copy in sync.
	if (!dbUserSettings.error && Object.keys(dbUserSettings.result).length > 0) {
		// TODO: only overwrite map position if current position is default
		setUserSettings(dbUserSettings.result);
		if (browser && window.localStorage) {
			localStorage.setItem("userSettings", JSON.stringify(userSettings));
		}
	}
}

export function setUserSettings(newUserSettings: LegacyUserSettings) {
	const mergedUserSettings = deepMerge(getDefaultUserSettings(), newUserSettings);
	userSettings = migrateUserSettings(mergedUserSettings);
}

export function getUserSettings() {
	return userSettings;
}

/**
 * Longest a change waits before reaching the server. Map moves would otherwise
 * write once per gesture, for a position that changes again a moment later.
 */
const SETTINGS_SYNC_DELAY_MS = 2000;

const SETTINGS_ENDPOINT = "/api/user/settings";
const POSITION_ENDPOINT = "/api/user/settings/position";

/** The Fetch spec rejects a keepalive request whose body exceeds this. */
const KEEPALIVE_MAX_BYTES = 64 * 1024;

/**
 * Consecutive failed saves before the retry stops re-arming itself. Some
 * failures never resolve — a blob past the server's body limit is refused every
 * time — and retrying one of those on every change achieves nothing. A later
 * edit starts the count over, so a transient outage still recovers.
 */
const MAX_SYNC_FAILURES = 3;

let syncTimer: ReturnType<typeof setTimeout> | undefined;
/** Something other than the map position changed, so the whole object must go. */
let fullSyncPending = false;
let positionSyncPending = false;
let lastSyncedUserSettings: string | undefined;
let syncFailures = 0;

/** Everything the client keeps locally, regardless of what the server is told. */
function persistUserSettingsLocally(): string {
	const serialized = JSON.stringify(userSettings);
	if (browser && window.localStorage) localStorage.setItem("userSettings", serialized);
	return serialized;
}

function scheduleSync() {
	// A plain trailing debounce would starve while the map is being panned
	// continuously, so the timer is not restarted — one write per window.
	if (syncTimer) return;
	syncTimer = setTimeout(() => syncUserSettings(false), SETTINGS_SYNC_DELAY_MS);
}

export function updateUserSettings() {
	const serialized = persistUserSettingsLocally();

	if (!getUserDetails().details) return;
	if (serialized === lastSyncedUserSettings) return;

	// A real edit deserves a fresh run of attempts, whatever happened to the
	// last one — otherwise a spent budget silently disables saving for good.
	syncFailures = 0;
	fullSyncPending = true;
	scheduleSync();
}

/**
 * Record where the user is looking. Split from updateUserSettings because the
 * map calls it on every move, and the settings endpoint replaces the entire
 * stored object — every filter and filterset — for what is three numbers.
 */
export function updateMapPosition() {
	persistUserSettingsLocally();

	if (!getUserDetails().details) return;

	positionSyncPending = true;
	scheduleSync();
}

function syncUserSettings(unloading: boolean) {
	if (syncTimer) {
		clearTimeout(syncTimer);
		syncTimer = undefined;
	}

	if (fullSyncPending) {
		fullSyncPending = false;
		const payload = JSON.stringify(userSettings);

		if (payload !== lastSyncedUserSettings) {
			// A full write carries the position too, so it supersedes a pending one.
			positionSyncPending = false;
			lastSyncedUserSettings = payload;
			// Sent from the serialized form, so what goes over the wire is exactly what
			// was compared — and free of the reactive proxies the live object is made of.
			post(
				SETTINGS_ENDPOINT,
				JSON.parse(payload),
				unloading,
				() => {
					lastSyncedUserSettings = undefined;
					// Re-arm, so the change is retried on the next one or at unload.
					// Nothing else would resend it: map moves take the position path now,
					// where before this they rewrote the whole object and healed it.
					if (++syncFailures <= MAX_SYNC_FAILURES) fullSyncPending = true;
					else console.warn("Giving up on syncing settings after repeated failures");
				},
				() => (syncFailures = 0)
			);
			return;
		}
		// Nothing to write after all — fall through, so a position queued behind
		// this one is not swallowed by having been cleared for a send that never
		// happened.
	}

	if (positionSyncPending) {
		positionSyncPending = false;
		const { center, zoom } = userSettings.mapPosition;
		post(
			POSITION_ENDPOINT,
			{ lat: center.lat, lng: center.lng, zoom },
			unloading,
			// The position is resent on the next move anyway.
			() => {}
		);
	}
}

function post(
	url: string,
	body: unknown,
	unloading: boolean,
	onFailure: () => void,
	onSuccess: () => void = () => {}
) {
	// msgpack where the platform allows it; the helper falls back to JSON on
	// native, where the CapacitorHttp wrapper would corrupt a binary body.
	const encoded = encodeRequestBody(body);

	// keepalive rather than sendBeacon: a beacon skips window.fetch, which native
	// builds patch to reach the configured instance with their bearer token, so a
	// beacon there would post to the webview origin and be lost. keepalive
	// outlives the page the same way and still reports what happened.
	//
	// It is refused outright past 64 KiB though, and a settings blob can exceed
	// that, so an oversized unload send goes as an ordinary request instead — it
	// may be cut short, which beats being rejected for certain.
	// Byte length, not string length: the limit is bytes, and anything non-ASCII
	// — a Cyrillic search entry, an emoji in a filterset title — takes more than
	// one per character. Overshooting means fetch rejects the send outright
	// instead of falling back to an ordinary one.
	const size =
		typeof encoded.body === "string"
			? new TextEncoder().encode(encoded.body).byteLength
			: encoded.body.byteLength;
	const keepalive = unloading && size < KEEPALIVE_MAX_BYTES;

	fetch(url, {
		method: "POST",
		body: encoded.body,
		headers: getHeaders({ contentType: encoded.contentType }),
		keepalive
	})
		.then(async (response) => {
			// The endpoint answers 200 with an error body when the session has gone,
			// so response.ok alone would record a rejected write as a success.
			const failed = !response.ok || Boolean((await response.json().catch(() => null))?.error);
			// Let the next change try again rather than assuming this one landed.
			if (failed) onFailure();
			else onSuccess();
		})
		.catch(onFailure);
}

if (browser) {
	const flush = () => {
		if (fullSyncPending || positionSyncPending) syncUserSettings(true);
	};
	// pagehide rather than unload, which is unreliable on mobile Safari.
	window.addEventListener("pagehide", flush);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flush();
	});
}

function deepMerge(defaultObj: { [key: string]: any }, newObj: { [key: string]: any }) {
	const result = { ...defaultObj };
	for (const key in newObj) {
		if (newObj[key] instanceof Object && !(newObj[key] instanceof Array) && key in defaultObj) {
			result[key] = deepMerge(defaultObj[key], newObj[key]);
		} else {
			result[key] = newObj[key];
		}
	}
	return result;
}

function migrateUserSettings(settings: LegacyUserSettings): UserSettings {
	if (settings.expandedMapObjects) {
		for (const objectType of settings.expandedMapObjects) {
			if (settings?.actions?.[objectType]) {
				settings.actions[objectType].expanded = true;
			}
		}
		delete settings.expandedMapObjects;
	}

	return settings as UserSettings;
}
