import { db } from "@/lib/server/db/internal";
import * as table from "@/lib/server/db/internal/schema";
import { encodeBase32LowerCase } from "@oslojs/encoding";
import { eq } from "drizzle-orm";

export function generateUserId() {
	// ID with 120 bits of entropy, or about the same as UUID v4.
	const bytes = crypto.getRandomValues(new Uint8Array(15));
	return encodeBase32LowerCase(bytes);
}

export async function getUserByDiscordId(discordId: string) {
	const [result] = await db.select().from(table.user).where(eq(table.user.discordId, discordId));
	return result ?? null;
}

// Create a DB user row for a gateway-authenticated Discord id. These users
// never go through Discord OAuth, so Better Auth never creates a row for them;
// we synthesise the required columns. The email is deterministic and unique per
// discordId and is never used for login. May throw ER_DUP_ENTRY on a race —
// callers should re-fetch on the duplicate-key error.
export async function createHeaderAuthUser(discordId: string, name: string) {
	const id = generateUserId();
	const now = new Date();
	await db.insert(table.user).values({
		id,
		name: name || discordId,
		email: `header-${discordId}@diadem.invalid`,
		emailVerified: false,
		discordId,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

// Reject anything that isn't a path on this origin. Blocks protocol-relative
// (`//evil.com`) and absolute URLs so we can't be used as an open redirect.
export function sanitizeRedirectPath(redirectPath: string | null | undefined, fallback: string) {
	if (!redirectPath) return fallback;
	if (!redirectPath.startsWith("/") || redirectPath.startsWith("//")) return fallback;
	return redirectPath;
}
