import type { LocalsUser } from "../../../app";
import { isAuthRequired } from "@/lib/services/config/config.server";
import { hasAnySubFeatureAnywhere, hasFeatureAnywhere } from "@/lib/services/user/checkPerm";

import type { FeaturesKey, Perms } from "@/lib/utils/features";
import type { MapObjectType } from "@/lib/mapObjects/mapObjectTypes";

export function checkIfAuthed(user: LocalsUser) {
	return Boolean(!isAuthRequired() || user);
}

export function hasFeatureAnywhereServer(perms: Perms, feature: FeaturesKey, user: LocalsUser) {
	return checkIfAuthed(user) && hasFeatureAnywhere(perms, feature);
}

export function hasAnySubFeatureAnywhereServer(
	perms: Perms,
	type: MapObjectType,
	user: LocalsUser
) {
	return checkIfAuthed(user) && hasAnySubFeatureAnywhere(perms, type);
}
