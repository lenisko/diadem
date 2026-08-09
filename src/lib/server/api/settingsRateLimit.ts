import { RateLimiterMemory } from "rate-limiter-flexible";

/**
 * A modest cap on settings writes. Both settings endpoints UPDATE the user's row
 * on every request, and neither goes through the map object limiter, so a stuck
 * client — or a deliberate loop — could drive unbounded row writes.
 *
 * Deliberately not behind `limits.enableRateLimiting`: that flag guards how much
 * map data a client may pull, which is a policy choice, while this only stops a
 * client writing far faster than the UI can possibly ask it to. The client
 * coalesces to at most one write every two seconds, so this is well clear of
 * anything legitimate.
 */
const writesPerMinute = 60;

const limiter = new RateLimiterMemory({
	points: writesPerMinute,
	duration: 60,
	keyPrefix: "settings_"
});

/** False when this client has written too often and should be refused. */
export async function allowSettingsWrite(userId: string): Promise<boolean> {
	try {
		await limiter.consume(userId, 1);
		return true;
	} catch {
		return false;
	}
}
