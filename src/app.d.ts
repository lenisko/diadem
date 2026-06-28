import type { ParaglideLocals } from "@inlang/paraglide-sveltekit";
import type { AvailableLanguageTag } from "../../lib/paraglide/runtime";

import type { Perms } from "@/lib/utils/features";
import type { BetterAuthSessionData } from "@/lib/server/auth/betterAuth";
import type { User } from "@/lib/server/db/internal/schema";
import type { OverlayEntry } from "@/lib/ui/overlays.svelte";

// Display identity forwarded by an upstream auth gateway (header auth). Kept
// separate from the DB `user` row, which only carries id/discordId/settings.
export type HeaderProfile = {
	username: string;
	displayName: string;
	avatarUrl: string;
	roles: string[];
	roleIds: string[];
};

declare global {
	namespace App {
		interface PageState {
			overlays?: OverlayEntry[];
		}

		interface Locals {
			paraglide: ParaglideLocals<AvailableLanguageTag>;
			user: User | null;
			session: BetterAuthSessionData | null;
			perms: Perms;
			authSource: "header" | "cookie" | null;
			headerProfile: HeaderProfile | null;
		}
	}
}

export {};
