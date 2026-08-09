import { getId } from "@/lib/utils/uuid";

/**
 * A random id identifying this browser to the server, so per-client state — the
 * filter cache — isn't shared with everyone else behind the same address. Lives
 * for the page load only; it is not an identity and nothing is authorized by it.
 */
let clientId: string | undefined;

export function getClientId(): string {
	if (!clientId) clientId = getId();
	return clientId;
}
