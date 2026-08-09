import { db } from "@/lib/server/db/internal/index";
import * as table from "@/lib/server/db/internal/schema";
import { eq } from "drizzle-orm";

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
 */
export async function setUserMapPosition(
	userId: string,
	mapPosition: StoredMapPosition
): Promise<void> {
	const stored = await getUserSettings(userId);
	if (stored === undefined || stored === null) return;

	// The column is JSON; depending on the driver it comes back parsed or raw.
	let settings: Record<string, unknown>;
	try {
		settings = (typeof stored === "string" ? JSON.parse(stored) : stored) as Record<
			string,
			unknown
		>;
	} catch {
		return;
	}
	if (!settings || typeof settings !== "object") return;

	settings.mapPosition = mapPosition;
	await setUserSettings(userId, JSON.stringify(settings));
}
