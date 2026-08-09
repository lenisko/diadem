import type { AnyFilter } from "@/lib/features/filters/filters";
import type { MapObjectType } from "@/lib/mapObjects/mapObjectTypes";
import TTLCache from "@isaacs/ttlcache";

/**
 * Remembers the filters a client has sent for each (client, map object type)
 * pair so that polls only have to carry a short hash instead of the entire
 * filter JSON — which is by far the largest part of a poll request.
 *
 * A few filters are kept per client and type rather than one. Logged-out clients
 * are keyed by IP, so everyone behind a single NAT shares an entry; with one slot
 * they would evict each other on every poll and every request would pay the extra
 * round trip the hash exists to avoid. The same slack covers toggling in and out
 * of an active search, which alternates between two filters for one type.
 */
const FILTER_CACHE_TTL = 30 * 60 * 1000;
const FILTER_CACHE_MAX = 20_000;
const FILTERS_PER_KEY = 4;
/**
 * Filters past this size are not cached. Those clients resend instead.
 */
const MAX_CACHED_FILTER_BYTES = 16 * 1024;
/**
 * Total retained filter bytes. Entry counts alone don't bound this: filters are
 * arbitrary client JSON held for the full TTL, so the count ceiling times the
 * per-filter ceiling is gigabytes. Oldest keys are evicted to stay under it.
 *
 * Measured as serialized length, while what is retained is the decoded object
 * graph — several times larger in the heap for small-key JSON. The budget is set
 * low with that multiplier in mind, and it is per process, so a clustered
 * deployment holds one budget per worker.
 */
const FILTER_CACHE_BYTE_BUDGET = 8 * 1024 * 1024;

type CachedFilter = { filter: AnyFilter; bytes: number };

let cachedBytes = 0;

const filterCache = new TTLCache<string, Map<string, CachedFilter>>({
	ttl: FILTER_CACHE_TTL,
	max: FILTER_CACHE_MAX,
	// A client polling by hash never re-sends the filter, so without this its
	// entry expires the TTL after the last full send and it pays a 409 plus a
	// full resend for every type, every TTL, for the life of the session.
	updateAgeOnGet: true,
	dispose: (filters) => {
		for (const entry of filters.values()) cachedBytes -= entry.bytes;
	}
});

function cacheKey(clientKey: string, type: MapObjectType): string {
	return clientKey + " " + type;
}

/** Returns false when the filter is too large to cache and must always be sent. */
export function rememberFilter(
	clientKey: string,
	type: MapObjectType,
	hash: string,
	filter: AnyFilter
): boolean {
	const serialized = JSON.stringify(filter);
	if (serialized.length > MAX_CACHED_FILTER_BYTES) return false;
	const bytes = serialized.length;

	// Cache a copy. The stored filter is handed to the query path on every later
	// poll, so keeping the request's own object would make "nothing downstream
	// mutates a filter" a silent, load-bearing invariant.
	const stored = JSON.parse(serialized) as AnyFilter;

	const key = cacheKey(clientKey, type);
	const filters = filterCache.get(key) ?? new Map<string, CachedFilter>();

	// Re-insert so this hash counts as the most recently used one.
	const existing = filters.get(hash);
	if (existing) cachedBytes -= existing.bytes;
	filters.delete(hash);
	filters.set(hash, { filter: stored, bytes });
	cachedBytes += bytes;

	while (filters.size > FILTERS_PER_KEY) {
		const oldest = filters.keys().next().value;
		if (oldest === undefined) break;
		cachedBytes -= filters.get(oldest)?.bytes ?? 0;
		filters.delete(oldest);
	}

	filterCache.set(key, filters);
	evictToBudget();
	return true;
}

/** TTLCache iterates soonest-to-expire first, which with one TTL is oldest first. */
function evictToBudget() {
	while (cachedBytes > FILTER_CACHE_BYTE_BUDGET) {
		const oldest = filterCache.keys().next().value;
		if (oldest === undefined) break;
		filterCache.delete(oldest);
	}
}

/** The cached filter for this hash, or undefined when the client must resend it. */
export function recallFilter(
	clientKey: string,
	type: MapObjectType,
	hash: string
): AnyFilter | undefined {
	const filters = filterCache.get(cacheKey(clientKey, type));
	const entry = filters?.get(hash);
	if (!filters || !entry) return undefined;

	// Re-insert so the hash being actively polled is the last one evicted when
	// this key fills up, rather than the first because it was inserted earliest.
	filters.delete(hash);
	filters.set(hash, entry);
	return entry.filter;
}
