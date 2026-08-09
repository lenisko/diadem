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
	let filter: AnyFilter | undefined = data.filter;
	let uncacheable = false;
	if (data.filterHash) {
		if (filter) {
			uncacheable = !rememberFilter(filterKey, type, data.filterHash, filter);
		} else {
			filter = recallFilter(filterKey, type, data.filterHash);
			if (!filter) {
				return respond(request, { data: [] }, { status: constants.HTTP_STATUS_CONFLICT });
			}
		}
	}

	const permitted = checkFeaturesInBounds(locals.perms, family, data);

	if (!permitted) {
		return respond(request, { data: [] }, { status: constants.HTTP_STATUS_UNAUTHORIZED });
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
			{ headers, status: constants.HTTP_STATUS_TOO_MANY_REQUESTS }
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
	// Tell the client not to poll this filter by hash: it is too large to cache,
	// so every hash-only attempt would 409 and cost a second round trip.
	const response = respond(
		request,
		result,
		uncacheable ? { headers: { "X-Filter-Cached": "0" } } : undefined
	);
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
