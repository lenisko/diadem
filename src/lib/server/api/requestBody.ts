import { decode } from "@msgpack/msgpack";

/**
 * Read a request body as msgpack or JSON, depending on its Content-Type.
 * Clients send msgpack where they can — it is roughly half the size of the
 * equivalent JSON and request bodies are never compressed by the browser.
 *
 * Null properties are dropped: msgpack has no undefined, so an absent optional
 * field arrives as null and would defeat `!== undefined` guards such as the
 * `since` delta cursor. Nested too — the stream's subscriptions carry their own.
 */
export async function readRequestBody<T>(request: Request): Promise<T> {
	const contentType = request.headers.get("Content-Type") ?? "";

	const body = contentType.includes("application/msgpack")
		? decode(new Uint8Array(await request.arrayBuffer()))
		: await request.json();

	dropNulls(body);
	return body as T;
}

function dropNulls(value: unknown): void {
	if (!value || typeof value !== "object") return;

	if (Array.isArray(value)) {
		for (const item of value) dropNulls(item);
		return;
	}

	for (const [key, entry] of Object.entries(value)) {
		if (entry === null) delete (value as Record<string, unknown>)[key];
		else dropNulls(entry);
	}
}
