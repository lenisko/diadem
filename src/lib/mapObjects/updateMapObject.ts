import { getActiveSearch } from "@/lib/features/activeSearch.svelte.js";
import type { AnyFilter, FilterS2Cell } from "@/lib/features/filters/filters";
import { updateFeatures } from "@/lib/map/featuresGen.svelte";
import { getMap } from "@/lib/map/map.svelte";
import {
	clearAllDataLimits,
	clearDataLimit,
	getDataLimit,
	setDataLimit
} from "@/lib/mapObjects/dataLimitState.svelte";
import { type Bounds, getBounds } from "@/lib/mapObjects/mapBounds";
import {
	addMapObjects,
	clearAllMapObjects,
	clearMapObjects,
	getMapObjects,
	replaceMapObjects
} from "@/lib/mapObjects/mapObjectsState.svelte.js";
import { allMapObjectTypes, type MapData, MapObjectType } from "@/lib/mapObjects/mapObjectTypes";
import { getS2CellMapObjects } from "@/lib/mapObjects/s2cells.js";
import { updateWeather } from "@/lib/mapObjects/weather.svelte";
import type { MapObjectResponse } from "@/lib/server/queryMapObjects/MapObjectQuery";
import { hasAnyFeatureAnywhere } from "@/lib/services/user/checkPerm";
import { getUserDetails } from "@/lib/services/user/userDetails.svelte";
import { featureFamily } from "@/lib/utils/features";
import { getUserSettings } from "@/lib/services/userSettings.svelte.js";
import { currentTimestamp } from "@/lib/utils/currentTimestamp";
import { getFilterHash } from "@/lib/utils/filterHash";
import { encodeRequestBody, getHeaders, parseResponse } from "@/lib/utils/requests";
import { SvelteMap } from "svelte/reactivity";

export type MapObjectRequestData = Bounds & {
	filter?: AnyFilter | undefined;
	/** Stable hash of `filter`. When set without `filter`, the server uses its cached copy. */
	filterHash?: string;
	since?: number;
};

/** The server has no cached filter for the sent hash and wants a full resend. */
const STATUS_FILTER_UNKNOWN = 409;

/**
 * Hashes not worth asking about by hash at all, so the filter goes out in full
 * from the start. Either the server said it is too large to cache, or asking has
 * repeatedly come back as a miss — which is what a multi-process deployment
 * without sticky routing looks like, since each process caches separately.
 * Without this, those clients would pay two requests per poll forever: strictly
 * worse than sending the filter every time, which is what this avoids.
 */
const alwaysSendFilterHashes = new Set<string>();

/**
 * Hashes the server has answered for. A filter it has never seen is sent in
 * full the first time — asking by hash first would 409 and resend, so every
 * page load and every filter edit would cost two serialized requests per type
 * on the most latency-sensitive path there is.
 */
const knownFilterHashes = new Set<string>();

/** Consecutive misses per hash, and how many are tolerated before giving up on it. */
const filterHashMisses = new Map<string, number>();
const MAX_FILTER_HASH_MISSES = 3;

let currentController: AbortController | undefined;
const lastQueryTimestamps = new SvelteMap<MapObjectType, number>();

export function resetLastQueryTimestamps() {
	lastQueryTimestamps.clear();
}

export function getLastQueryTimestamps() {
	return lastQueryTimestamps;
}

/** A hash the server keeps failing to resolve isn't worth asking about again. */
function recordFilterHashMiss(hash: string) {
	const misses = (filterHashMisses.get(hash) ?? 0) + 1;
	if (misses >= MAX_FILTER_HASH_MISSES) {
		alwaysSendFilterHashes.add(hash);
		knownFilterHashes.delete(hash);
		filterHashMisses.delete(hash);
		return;
	}
	filterHashMisses.set(hash, misses);
}

export function clearMap() {
	// TODO: Also do this on login
	clearAllMapObjects();
	resetLastQueryTimestamps();
	clearAllDataLimits();
	// What the server holds for us is no longer worth assuming after a reset,
	// and these would otherwise grow for the life of the page.
	knownFilterHashes.clear();
	alwaysSendFilterHashes.clear();
	filterHashMisses.clear();
	updateFeatures(getMapObjects());
}

export async function fetchMapObjects<T extends MapData>(
	type: MapObjectType,
	bounds: Bounds,
	filter: AnyFilter | undefined = undefined,
	signal?: AbortSignal,
	since?: number
): Promise<MapObjectResponse<T> | undefined> {
	const currentBounds = getBounds();
	const filterHash = getFilterHash(filter);

	async function post(withFilter: boolean): Promise<Response> {
		const body: MapObjectRequestData = {
			...currentBounds,
			filter: withFilter ? filter : undefined,
			filterHash,
			since
		};
		const encoded = encodeRequestBody(body);
		return await fetch("/api/" + type, {
			method: "POST",
			body: encoded.body,
			headers: getHeaders({ msgpack: true, contentType: encoded.contentType, clientId: true }),
			signal
		});
	}

	try {
		// Send the filter the first time it is used and whenever asking by hash has
		// proven not to work; poll by hash alone once the server is known to hold it.
		const sendFilter =
			filterHash === undefined ||
			!knownFilterHashes.has(filterHash) ||
			alwaysSendFilterHashes.has(filterHash);

		let response = await post(sendFilter);
		// The server dropped it — a restart, the cache expiring, or another process
		// in a multi-worker deployment that has not seen this filter yet.
		if (response.status === STATUS_FILTER_UNKNOWN) {
			if (filterHash !== undefined) recordFilterHashMiss(filterHash);
			response = await post(true);
		} else if (filterHash !== undefined) {
			filterHashMisses.delete(filterHash);
		}

		if (filterHash !== undefined) {
			// Read on failures too — the server sets it there so a client being
			// rate-limited still learns to stop asking by hash.
			if (response.headers.get("X-Filter-Cached") === "0") {
				alwaysSendFilterHashes.add(filterHash);
				knownFilterHashes.delete(filterHash);
			} else if (response.ok) {
				knownFilterHashes.add(filterHash);
			}
		}

		return await parseResponse<MapObjectResponse<T>>(response);
	} catch (e) {
		if (e instanceof DOMException && e.name === "AbortError") {
			return;
		}
		console.error(`Error while fetching ${type}`, e);
	}
}

export async function updateMapObject(
	type: MapObjectType,
	removeOld: boolean = true,
	filterOverwrite: AnyFilter | undefined = undefined,
	signal?: AbortSignal,
	onlyChanged: boolean = false
) {
	if (!hasAnyFeatureAnywhere(getUserDetails().permissions, featureFamily[type])) return;
	if (type === MapObjectType.ROUTE) return;

	let filter: AnyFilter | undefined = undefined;

	if (filterOverwrite) {
		filter = filterOverwrite;
	} else {
		if (type === MapObjectType.POKEMON) {
			filter = getUserSettings().filters.pokemon;
		} else if (type === MapObjectType.POKESTOP) {
			filter = getUserSettings().filters.pokestop;
		} else if (type === MapObjectType.GYM) {
			filter = getUserSettings().filters.gym;
		} else if (type === MapObjectType.STATION) {
			filter = getUserSettings().filters.station;
		} else if (type === MapObjectType.NEST) {
			filter = getUserSettings().filters.nest;
		} else if (type === MapObjectType.SPAWNPOINT) {
			filter = getUserSettings().filters.spawnpoint;
			// } else if (type === MapObjectType.ROUTE) {
			// 	filter = getUserSettings().filters.route;
		} else if (type === MapObjectType.TAPPABLE) {
			filter = getUserSettings().filters.tappable;
		} else if (type === MapObjectType.S2_CELL) {
			filter = getUserSettings().filters.s2cell;
		} else {
			console.log("unknown type while udpating map objects!");
			return;
		}
	}

	if (!filter || !filter.enabled) {
		clearMapObjects(type);
		clearDataLimit(type);
		if (!signal) updateFeatures(getMapObjects());
		return;
	}

	const limitInfo = getDataLimit(type);
	if (limitInfo) {
		// don't refetch a limited type until the map was zoomed in or its filters changed
		const zoomedIn = (getMap()?.getZoom() ?? 0) > limitInfo.zoom + 0.01;
		const filterChanged = JSON.stringify(filter) !== limitInfo.filterJson;
		if (!zoomedIn && !filterChanged) return;
	}

	const since = onlyChanged ? lastQueryTimestamps.get(type) : undefined;
	const isDelta = onlyChanged && since !== undefined;
	lastQueryTimestamps.set(type, currentTimestamp());

	let examined: number = 0;
	let data: MapData[] | undefined = undefined;
	let clearLimitAfterRender = false;
	if (type === MapObjectType.S2_CELL) {
		data = getS2CellMapObjects(getBounds(), filter as FilterS2Cell);
		examined = data.length;
	} else {
		const response = await fetchMapObjects(type, getBounds(), filter, signal, since);
		if (signal?.aborted) return;
		if (response) {
			if (response.limitReached) {
				setDataLimit(type, {
					zoom: getMap()?.getZoom() ?? 0,
					filterJson: JSON.stringify(filter)
				});
				data = [];
			} else {
				data = response.data;
				clearLimitAfterRender = Boolean(limitInfo);
			}
			examined = response.examined;
		}
	}

	if (!data) {
		if (!signal) updateFeatures(getMapObjects());
		return;
	}

	try {
		if (removeOld && !isDelta) {
			replaceMapObjects(data, type, examined);
		} else {
			addMapObjects(data, type, examined, isDelta);
		}
	} catch (e) {
		clearLimitAfterRender = false;
		console.log(data);
		console.error(e);
	}

	if (!signal) {
		updateFeatures(getMapObjects());
		if (clearLimitAfterRender) clearDataLimit(type);
	}

	return clearLimitAfterRender ? type : undefined;
}

export async function updateAllMapObjects(removeOld: boolean = true, onlyChanged: boolean = false) {
	if (onlyChanged && currentController) return;

	currentController?.abort();
	const controller = new AbortController();
	currentController = controller;

	const activeSearch = getActiveSearch();
	let limitsToClear: MapObjectType[] = [];

	if (activeSearch) {
		for (const mapObjectType of allMapObjectTypes) {
			if (mapObjectType !== activeSearch.mapObject) clearMapObjects(mapObjectType);
		}
		const limitToClear = await updateMapObject(
			activeSearch.mapObject,
			removeOld,
			activeSearch.filter,
			controller.signal,
			onlyChanged
		);
		if (limitToClear) limitsToClear.push(limitToClear);
	} else {
		const [limitResults] = await Promise.all([
			Promise.all(
				allMapObjectTypes.map((type) =>
					updateMapObject(type, removeOld, undefined, controller.signal, onlyChanged)
				)
			),
			updateWeather()
		]);
		limitsToClear = limitResults.filter((type) => type !== undefined);
	}

	if (controller.signal.aborted) return;
	currentController = undefined;
	updateFeatures(getMapObjects());
	for (const type of limitsToClear) clearDataLimit(type);
}
