import { MapObjectType } from "@/lib/mapObjects/mapObjectTypes";
import type { Polygon } from "geojson";

enum NonMapObjectFeature {
	ALL = "*",
	SCOUT = "scout",
	WEATHER = "weather",
	QUEST = "quest",
	LURE = "lure",
	INVASION = "invasion",
	SHOWCASE = "showcase",
	KECLEON = "kecleon",
	GOLD_POKESTOP = "goldPokestop",
	RAID = "raid",
	DEFENDER = "defender",
	DYNAMAX = "dynamax"
}

export const Features = { ...MapObjectType, ...NonMapObjectFeature };
export type FeaturesKey = MapObjectType | NonMapObjectFeature;

// Sub-features that gate finer-grained data inside a MapObjectType endpoint.
// The MapObjectType key itself (e.g. "pokestop") is the "plain" sub-feature.
// A user must hold at least one entry to query the endpoint.
export const MAP_OBJECT_SUB_FEATURES: Record<MapObjectType, FeaturesKey[]> = {
	[MapObjectType.POKESTOP]: [
		MapObjectType.POKESTOP,
		NonMapObjectFeature.QUEST,
		NonMapObjectFeature.LURE,
		NonMapObjectFeature.INVASION,
		NonMapObjectFeature.SHOWCASE,
		NonMapObjectFeature.KECLEON,
		NonMapObjectFeature.GOLD_POKESTOP
	],
	[MapObjectType.GYM]: [MapObjectType.GYM, NonMapObjectFeature.RAID, NonMapObjectFeature.DEFENDER],
	[MapObjectType.STATION]: [MapObjectType.STATION, NonMapObjectFeature.DYNAMAX],
	[MapObjectType.POKEMON]: [MapObjectType.POKEMON],
	[MapObjectType.NEST]: [MapObjectType.NEST],
	[MapObjectType.SPAWNPOINT]: [MapObjectType.SPAWNPOINT],
	[MapObjectType.ROUTE]: [MapObjectType.ROUTE],
	[MapObjectType.TAPPABLE]: [MapObjectType.TAPPABLE],
	[MapObjectType.S2_CELL]: [MapObjectType.S2_CELL]
};

export type PermArea = {
	name: string;
	features: FeaturesKey[];
	polygon: Polygon;
};

export type Perms = {
	everywhere: FeaturesKey[];
	areas: PermArea[];
};
