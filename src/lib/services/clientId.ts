/**
 * A random id identifying this browser tab to the server, so per-client state
 * (the filter cache, the stream connection cap) isn't shared with everyone else
 * behind the same address. Lives for the page load only; it is not an identity
 * and nothing is authorized by it.
 */
let clientId: string | undefined;

export function getClientId(): string {
	if (!clientId) clientId = newId();
	return clientId;
}

/** crypto.randomUUID only exists in secure contexts, which a plain-http LAN instance is not. */
function newId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
