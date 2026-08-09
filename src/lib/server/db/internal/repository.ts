import { db } from "@/lib/server/db/internal/index";
import * as table from "@/lib/server/db/internal/schema";
import { eq, sql } from "drizzle-orm";

export async function setUserSettings(userId: string, userSettings: string) {
	const u = await db.update(table.user).set({ userSettings }).where(eq(table.user.id, userId));
}

export async function getUserSettings(userId: string): Promise<undefined | string> {
	const [result] = await db
		.select({ user: { userSettings: table.user.userSettings } })
		.from(table.user)
		.where(eq(table.user.id, userId));

	return result?.user?.userSettings as string | undefined;
}

export type StoredMapPosition = {
	center: { lat: number; lng: number };
	zoom: number;
};

/**
 * Update only the stored map position, leaving the rest of the settings alone.
 * The map writes this on every move, and it is a handful of numbers, so it is
 * kept off the path that rewrites the whole settings blob.
 *
 * Done in the database rather than read-modify-write, so a position written
 * while a full settings save is in flight cannot write back the object it read
 * before that save and lose it. COALESCE covers a user who has never stored
 * anything, whose column is still null.
 */
export async function setUserMapPosition(
	userId: string,
	mapPosition: StoredMapPosition
): Promise<void> {
	await db
		.update(table.user)
		.set({
			userSettings: sql`JSON_SET(COALESCE(${table.user.userSettings}, '{}'), '$.mapPosition', CAST(${JSON.stringify(mapPosition)} AS JSON))`
		})
		.where(eq(table.user.id, userId));
}
