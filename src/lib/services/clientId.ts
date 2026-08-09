import { browser } from "$app/environment";
import { getId } from "@/lib/utils/uuid";

/**
 * A random id identifying this browser to the server, so per-client state — the
 * filter cache — isn't shared with everyone else behind the same address. It is
 * not an identity and nothing is authorized by it.
 *
 * Kept in sessionStorage so a reload reuses it. A fresh id per page load would
 * orphan a full set of cache entries for their whole lifetime on every reload,
 * filling the cache with keys nobody will ever read again.
 */
const STORAGE_KEY = "diadem_client_id";

let clientId: string | undefined;

export function getClientId(): string {
	if (clientId) return clientId;

	if (browser) {
		try {
			const stored = sessionStorage.getItem(STORAGE_KEY);
			if (stored) return (clientId = stored);
		} catch {
			// Storage can be unavailable or full; an in-memory id still works.
		}
	}

	clientId = getId();
	if (browser) {
		try {
			sessionStorage.setItem(STORAGE_KEY, clientId);
		} catch {
			// As above — losing persistence only costs a cache entry per reload.
		}
	}
	return clientId;
}
