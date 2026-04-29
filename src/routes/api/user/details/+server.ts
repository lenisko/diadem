import { deleteSessionTokenCookie, invalidateSession } from "@/lib/server/auth/auth";
import { getUserInfo, isGuildMember } from "@/lib/server/auth/discordDetails";
import { getEveryonePerms } from "@/lib/server/auth/permissions";
import { getClientConfig } from "@/lib/services/config/config.server";
import type { UserData } from "@/lib/services/user/userDetails.svelte";
import { json } from "@sveltejs/kit";

export async function GET(event) {
	const user = event.locals.user;
	const session = event.locals.session;

	if (!user)
		return json({
			permissions: await getEveryonePerms(event.fetch)
		} as UserData);

	// Header-auth path: user came from upstream gateway, no Discord session.
	if (event.locals.authSource === "header") {
		return json({
			details: {
				id: user.discordId,
				username: user.username ? "@" + user.username : "",
				displayName: user.displayName || user.username || "",
				avatarUrl: user.avatarUrl ?? ""
			},
			permissions: user.permissions,
			isGuildMember: true,
			isHeaderAuth: true
		} as UserData);
	}

	const data = await getUserInfo(session.discordToken);

	if (!data) {
		await invalidateSession(event.locals.session.id);
		deleteSessionTokenCookie(event);
		return json({
			permissions: await getEveryonePerms(event.fetch)
		} as UserData);
	}

	const isMember = await isGuildMember(getClientConfig().discord.serverId, session.discordToken);

	return json({
		details: data,
		permissions: user.permissions,
		isGuildMember: isMember
	} as UserData);
}
