import { setUserMapPosition } from "@/lib/server/db/internal/repository";
import { noStoreHttpHeaders } from "@/lib/utils/apiUtils.server";
import { json } from "@sveltejs/kit";

type PositionBody = {
	lat?: number;
	lng?: number;
	zoom?: number;
};

function isValid(body: PositionBody): boolean {
	const { lat, lng, zoom } = body;
	return (
		typeof lat === "number" &&
		typeof lng === "number" &&
		typeof zoom === "number" &&
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		Number.isFinite(zoom) &&
		lat >= -90 &&
		lat <= 90 &&
		lng >= -180 &&
		lng <= 180 &&
		zoom >= 0 &&
		zoom <= 30
	);
}

/**
 * Store just where the user is looking. The map writes this on every move, so it
 * is split off from the settings endpoint, which replaces the entire stored
 * object — filters and all — for what is three numbers.
 */
export async function POST({ locals, request }) {
	if (!locals.user) return json({ error: "Not logged in" }, { headers: noStoreHttpHeaders });

	let body: PositionBody;
	try {
		body = await request.json();
	} catch {
		return json({ error: "Invalid body" }, { status: 400, headers: noStoreHttpHeaders });
	}

	if (!body || !isValid(body)) {
		return json({ error: "Invalid position" }, { status: 400, headers: noStoreHttpHeaders });
	}

	await setUserMapPosition(locals.user.id, {
		center: { lat: body.lat!, lng: body.lng! },
		zoom: body.zoom!
	});

	return json({ error: null }, { headers: noStoreHttpHeaders });
}
