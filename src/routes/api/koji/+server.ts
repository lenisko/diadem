import { fetchKojiGeofences } from "@/lib/server/api/kojiApi";
import { respond } from "@/lib/server/api/respond";
import { getServerConfig } from "@/lib/services/config/config.server";
import { cacheHttpHeaders } from "@/lib/utils/apiUtils.server";
import { error } from "@sveltejs/kit";

export async function GET(event) {
	const config = getServerConfig();
	if (!config.koji || !config.koji.url) return respond(event.request, []);

	const data = await fetchKojiGeofences(event.fetch);
	if (!data) error(500);
	return respond(event.request, data, { headers: cacheHttpHeaders(60, 300, 3600) });
}
