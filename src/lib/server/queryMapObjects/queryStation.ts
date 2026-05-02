import { DbMapObjectQuery } from "@/lib/server/queryMapObjects/MapObjectQuery";
import type { StationData } from "@/lib/types/mapObjectData/station";
import type { FilterStation } from "@/lib/features/filters/filters";
import { MapObjectType, type MinMapObject } from "@/lib/mapObjects/mapObjectTypes";
import { requestLimits } from "@/lib/server/api/rateLimit";
import { getNormalizedForm } from "@/lib/utils/pokemonUtils";
import { isPointInAllowedArea, type PermittedPolygon } from "@/lib/services/user/checkPerm";
import { matchMaxBattleFilterset, shouldDisplayStation } from "@/lib/features/filterLogic/station";
import { Features, type FeaturesKey, type Perms } from "@/lib/utils/features";

export class StationQuery extends DbMapObjectQuery<StationData, FilterStation> {
	protected readonly type = MapObjectType.STATION;
	protected readonly table = "station";
	protected readonly fields = [
		"id",
		"lat",
		"lon",
		"name",
		"start_time",
		"end_time",
		"is_battle_available",
		"is_inactive",
		"battle_level",
		"battle_pokemon_id",
		"battle_pokemon_form",
		"battle_pokemon_costume",
		"battle_pokemon_gender",
		"battle_pokemon_alignment",
		"battle_pokemon_bread_mode",
		"battle_pokemon_move_1",
		"battle_pokemon_move_2",
		"updated",
		"total_stationed_pokemon",
		"total_stationed_gmax",
		"stationed_pokemon"
	];
	protected readonly limit = requestLimits[MapObjectType.STATION];
	protected readonly idColumn = "station.id";

	protected readonly extraWhere = ["end_time > UNIX_TIMESTAMP()"];

	filter(
		data: MinMapObject<StationData>,
		filter: FilterStation,
		polygon: PermittedPolygon,
		perms?: Perms
	): boolean {
		if (!perms) return shouldDisplayStation(data, filter);

		const has = (f: FeaturesKey) => isPointInAllowedArea(perms, f, data.lat, data.lon);

		if (!filter.enabled) return false;

		if (has(Features.STATION) && filter.stationPlain.enabled) return true;

		if (has(Features.DYNAMAX)) {
			const maxBattleFilters = filter.maxBattle.filters.filter((f) => f.enabled);
			if (maxBattleFilters.length === 0 && !filter.stationPlain.enabled) return true;
			if (matchMaxBattleFilterset(data, filter)) return true;
		}

		return false;
	}

	prepare(data: MinMapObject<StationData>, perms?: Perms): void {
		data.battle_pokemon_form = getNormalizedForm(data.battle_pokemon_id, data.battle_pokemon_form);

		if (!perms) return;

		const has = (f: FeaturesKey) => isPointInAllowedArea(perms, f, data.lat, data.lon);

		if (!has(Features.DYNAMAX)) {
			data.battle_level = undefined;
			data.battle_pokemon_id = undefined;
			data.battle_pokemon_form = undefined;
			data.battle_pokemon_costume = undefined;
			data.battle_pokemon_gender = undefined;
			data.battle_pokemon_alignment = undefined;
			data.battle_pokemon_bread_mode = undefined;
			data.battle_pokemon_move_1 = undefined;
			data.battle_pokemon_move_2 = undefined;
			data.battle_start = undefined;
			data.battle_end = undefined;
			data.total_stationed_pokemon = undefined;
			data.total_stationed_gmax = undefined;
			data.stationed_pokemon = undefined;
			data.is_battle_available = 0;
		}
	}
}
