import { DbMapObjectQuery } from "@/lib/server/queryMapObjects/MapObjectQuery";
import type { GymData } from "@/lib/types/mapObjectData/gym";
import type { FilterGym } from "@/lib/features/filters/filters";
import { MapObjectType, type MinMapObject } from "@/lib/mapObjects/mapObjectTypes";
import { requestLimits } from "@/lib/server/api/rateLimit";
import { getNormalizedForm } from "@/lib/utils/pokemonUtils";
import { isPointInAllowedArea, type PermittedPolygon } from "@/lib/services/user/checkPerm";
import { shouldDisplayRaid } from "@/lib/features/filterLogic/gym";
import { Features, type FeaturesKey, type Perms } from "@/lib/utils/features";

export class GymQuery extends DbMapObjectQuery<GymData, FilterGym> {
	protected readonly type = MapObjectType.GYM;
	protected readonly table = "gym";
	protected readonly fields = [
		"id",
		"lat",
		"lon",
		"name",
		"url",
		"description",
		"last_modified_timestamp",
		"updated",
		"first_seen_timestamp",
		"raid_end_timestamp",
		"raid_spawn_timestamp",
		"raid_battle_timestamp",
		"raid_pokemon_id",
		"raid_pokemon_form",
		"raid_pokemon_cp",
		"raid_pokemon_move_1",
		"raid_pokemon_move_2",
		"raid_pokemon_gender",
		"raid_pokemon_costume",
		"raid_pokemon_evolution",
		"raid_pokemon_alignment",
		"raid_level",
		"team_id",
		"availble_slots",
		"in_battle",
		"ex_raid_eligible",
		"ar_scan_eligible",
		"power_up_level",
		"power_up_points",
		"power_up_end_timestamp",
		"defenders",
		"rsvps",
		"deleted"
	];
	protected readonly limit = requestLimits[MapObjectType.GYM];
	protected readonly idColumn = "gym.id";

	protected readonly extraWhere = ["deleted = 0"];

	protected getFilterWhere(filter: FilterGym | undefined): { sql: string; values: unknown[] } {
		if (filter && !filter.gymPlain.enabled && filter.raid.enabled) {
			return { sql: "raid_end_timestamp > UNIX_TIMESTAMP()", values: [] };
		}
		return { sql: "", values: [] };
	}

	filter(
		data: MinMapObject<GymData>,
		filter: FilterGym,
		polygon: PermittedPolygon,
		perms?: Perms
	): boolean {
		const has = (f: FeaturesKey) => !perms || isPointInAllowedArea(perms, f, data.lat, data.lon);

		return Boolean(
			(filter.gymPlain.enabled && has(Features.GYM)) ||
				(has(Features.RAID) && shouldDisplayRaid(data, filter))
		);
	}

	prepare(data: MinMapObject<GymData>, perms?: Perms): void {
		data.raid_pokemon_form = getNormalizedForm(data.raid_pokemon_id, data.raid_pokemon_form);

		if (!perms) return;

		const has = (f: FeaturesKey) => isPointInAllowedArea(perms, f, data.lat, data.lon);

		if (!has(Features.RAID)) {
			data.raid_end_timestamp = undefined;
			data.raid_spawn_timestamp = undefined;
			data.raid_battle_timestamp = undefined;
			data.raid_pokemon_id = undefined;
			data.raid_pokemon_form = undefined;
			data.raid_pokemon_cp = undefined;
			data.raid_pokemon_move_1 = undefined;
			data.raid_pokemon_move_2 = undefined;
			data.raid_pokemon_gender = undefined;
			data.raid_pokemon_costume = undefined;
			data.raid_pokemon_evolution = undefined;
			data.raid_pokemon_alignment = undefined;
			data.raid_level = undefined;
		}

		if (!has(Features.DEFENDER)) {
			data.defenders = undefined;
			data.rsvps = undefined;
		}
	}
}
