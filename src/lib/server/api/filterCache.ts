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

/** Retained bytes per cache, so one cannot spend the other's budget. */
const cachedBytes = new Map<TTLCache<string, Map<string, CachedFilter>>, number>();

function newCache(max: number) {
	const cache: TTLCache<string, Map<string, CachedFilter>> = new TTLCache({
		ttl: FILTER_CACHE_TTL,
		max,
		// Never updateAgeOnGet: it makes get() register an expiry for a key it did
		// not find, and that phantom then reaches dispose with no value — and is
		// invisible to `max`, which only counts entries that exist. The TTL is
		// refreshed explicitly on a hit instead, in recallFilter.
		dispose: (filters) => {
			if (!filters) return;
			let total = cachedBytes.get(cache) ?? 0;
			for (const entry of filters.values()) total -= entry.bytes;
			cachedBytes.set(cache, total);
		}
	});
	cachedBytes.set(cache, 0);
	return cache;
}

const authedFilterCache = newCache(FILTER_CACHE_MAX);
const anonFilterCache = newCache(FILTER_CACHE_MAX);

function cacheKey(clientKey: string, type: MapObjectType): string {
	return clientKey + " " + type;
}

/**
 * Signed-in clients get their own cache. A logged-out client's key is whatever
 * it sent as its id, so one address can mint keys freely and churn everything
 * else out; keeping the two apart means that only ever costs other anonymous
 * clients a resend, and never a signed-in user's entry.
 */
function cacheFor(clientKey: string): TTLCache<string, Map<string, CachedFilter>> {
	return clientKey.startsWith("u:") ? authedFilterCache : anonFilterCache;
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

	const cache = cacheFor(clientKey);
	const key = cacheKey(clientKey, type);
	const filters = cache.get(key) ?? new Map<string, CachedFilter>();

	// Re-insert so this hash counts as the most recently used one.
	let total = cachedBytes.get(cache) ?? 0;
	total -= filters.get(hash)?.bytes ?? 0;
	filters.delete(hash);
	filters.set(hash, { filter: stored, bytes });
	total += bytes;

	while (filters.size > FILTERS_PER_KEY) {
		const oldest = filters.keys().next().value;
		if (oldest === undefined) break;
		total -= filters.get(oldest)?.bytes ?? 0;
		filters.delete(oldest);
	}

	cachedBytes.set(cache, total);
	cache.set(key, filters);
	evictToBudget(cache);
	return true;
}

/** TTLCache iterates soonest-to-expire first, which with one TTL is oldest first. */
function evictToBudget(cache: TTLCache<string, Map<string, CachedFilter>>) {
	while ((cachedBytes.get(cache) ?? 0) > FILTER_CACHE_BYTE_BUDGET) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

/** The cached filter for this hash, or undefined when the client must resend it. */
export function recallFilter(
	clientKey: string,
	type: MapObjectType,
	hash: string
): AnyFilter | undefined {
	const cache = cacheFor(clientKey);
	const key = cacheKey(clientKey, type);
	const filters = cache.get(key);
	const entry = filters?.get(hash);
	if (!filters || !entry) return undefined;

	// Re-insert so the hash being actively polled is the last one evicted when
	// this key fills up, rather than the first because it was inserted earliest.
	filters.delete(hash);
	filters.set(hash, entry);
	// A client polling by hash never re-sends the filter, so without this the
	// entry expires a TTL after the last full send and every type pays a 409
	// plus a resend, every TTL, for the life of the session. Only ever on a hit:
	// setTTL for an absent key creates the same phantom entry get() would.
	cache.setTTL(key, FILTER_CACHE_TTL);
	return entry.filter;
}
