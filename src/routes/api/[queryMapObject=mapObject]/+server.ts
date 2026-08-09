import type { AnyFilter } from "@/lib/features/filters/filters";
import { MapObjectType } from "@/lib/mapObjects/mapObjectTypes";
import type { MapObjectRequestData } from "@/lib/mapObjects/updateMapObject";
import { getClientIdentity } from "@/lib/server/api/clientIdentity";
import { recallFilter, rememberFilter } from "@/lib/server/api/filterCache";
import { readRequestBody } from "@/lib/server/api/requestBody";
import {
	calculateRequestCharge,
	rateLimit,
	rateLimitConsume,
	rateLimitReward,
	requestLimits
} from "@/lib/server/api/rateLimit";
import { respond } from "@/lib/server/api/respond";
import { hasAnyFeatureAnywhereServer } from "@/lib/server/auth/checkIfAuthed";
import { queryMapObjects } from "@/lib/server/queryMapObjects/queryMapObjects";
import { checkFeaturesInBounds, FeaturePermissionContext } from "@/lib/services/user/checkPerm";
import { featureFamily } from "@/lib/utils/features";
import { getLogger } from "@/lib/utils/logger";
import { error } from "@sveltejs/kit";
import { constants } from "http2";
import type { RequestHandler } from "./$types";

const log = getLogger("mapobjects");

/** Shape of getFilterHash's output; anything else never matches a cache entry. */
const FILTER_HASH_PATTERN = /^[0-9a-z]{1,16}$/;

/**
 * Charged when a client polls with a hash the server doesn't hold. Small — it is
 * a real part of the protocol — but not nothing, so it can't be used to bypass
 * the limiter entirely.
 */
const FILTER_CONFLICT_CHARGE = 100;

export const POST: RequestHandler = async (event) => {
	const { request, locals, params, getClientAddress } = event;
	const rateLimitKey = locals.user?.id ?? getClientAddress();
	// Filters are cached per browser, not per address: behind a reverse proxy every
	// logged-out visitor shares one address and would contend for one cache slot.
	const filterKey = getClientIdentity(event);
	const type = params.queryMapObject as MapObjectType;
	const family = featureFamily[type];

	const start = performance.now();
	if (!hasAnyFeatureAnywhereServer(locals.perms, family, locals.user)) error(401);
	const permCheckTime = performance.now();

	const data: MapObjectRequestData = await readRequestBody(request);

	// Clients poll with a filter hash instead of the whole filter. Ask for a
	// full resend whenever the cached copy is missing or stale.
	const filterHash = FILTER_HASH_PATTERN.test(data.filterHash ?? "") ? data.filterHash : undefined;
	let filter: AnyFilter | undefined = data.filter;
	// Carried on every response, including the failures: a client that never
	// learns its filter is uncacheable retries by hash forever, doubling its
	// request rate exactly when the server is shedding load.
	let extraHeaders: Record<string, string> | undefined;
	if (filterHash) {
		if (filter) {
			if (!rememberFilter(filterKey, type, filterHash, filter)) {
				extraHeaders = { "X-Filter-Cached": "0" };
			}
		} else {
			filter = recallFilter(filterKey, type, filterHash);
			if (!filter) {
				// Not free: otherwise a random hash buys an unlimited run of requests
				// that skip the limiter entirely.
				await rateLimit(rateLimitKey, FILTER_CONFLICT_CHARGE, type);
				return respond(
					request,
					{ data: [] },
					{ headers: extraHeaders, status: constants.HTTP_STATUS_CONFLICT }
				);
			}
		}
	}

	const permitted = checkFeaturesInBounds(locals.perms, family, data);

	if (!permitted) {
		return respond(
			request,
			{ data: [] },
			{ headers: extraHeaders, status: constants.HTTP_STATUS_UNAUTHORIZED }
		);
	}

	const permissionContext = new FeaturePermissionContext(locals.perms, family);

	const requestLimit = requestLimits[type];
	const [allowed, _, totalLimit, headers] = await rateLimitConsume(
		rateLimitKey,
		requestLimit,
		type
	);

	if (!allowed) {
		log.info(
			"[%s] User %s reached %d and was rate-limited",
			params.queryMapObject,
			locals.user?.id ?? "<ip>",
			totalLimit
		);
		return respond(
			request,
			{ data: [] },
			{ headers: { ...headers, ...extraHeaders }, status: constants.HTTP_STATUS_TOO_MANY_REQUESTS }
		);
	}

	const result = await queryMapObjects(
		type,
		permitted.bounds,
		filter,
		permitted.polygon,
		data.since,
		requestLimit,
		permissionContext
	).catch(async (e) => {
		await rateLimitReward(rateLimitKey, requestLimit, type);
		throw e;
	});

	let chargeForAmount = result.examined;
	const hardLimit = requestLimits[type];
	if (chargeForAmount > hardLimit) chargeForAmount = hardLimit;

	const charge = calculateRequestCharge(data.since, result.data.length, chargeForAmount);

	const refundPoints = requestLimit - charge;
	let remainingPoints = 1;
	if (refundPoints > 0) {
		remainingPoints = await rateLimitReward(rateLimitKey, refundPoints, type);
	} else if (refundPoints < 0) {
		remainingPoints = await rateLimit(rateLimitKey, -1 * refundPoints, type);
	}

	const queryTime = performance.now();
	const response = respond(request, result, extraHeaders ? { headers: extraHeaders } : undefined);
	const serializeTime = performance.now();

	log.info(
		"[%s] count: %d | rate limit: %d/%d (charged %d) | permcheck: %fms + query: %fms + serialize: %fms",
		params.queryMapObject,
		result.data.length,
		remainingPoints,
		totalLimit,
		charge,
		(permCheckTime - start).toFixed(1),
		(queryTime - permCheckTime).toFixed(1),
		(serializeTime - queryTime).toFixed(1)
	);

	return response;
};
