import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import { readRequestBody } from "@/lib/server/api/requestBody";

function msgpackRequest(body: unknown, options?: { ignoreUndefined?: boolean }): Request {
	return new Request("http://localhost/api/pokemon", {
		method: "POST",
		body: encode(body, options) as unknown as BodyInit,
		headers: { "Content-Type": "application/msgpack" }
	});
}

describe("readRequestBody", () => {
	it("decodes msgpack bodies", async () => {
		const body = await readRequestBody<{ minLat: number }>(msgpackRequest({ minLat: 1.5 }));
		expect(body.minLat).toBe(1.5);
	});

	it("decodes json bodies", async () => {
		const request = new Request("http://localhost/api/pokemon", {
			method: "POST",
			body: JSON.stringify({ minLat: 1.5 }),
			headers: { "Content-Type": "application/json" }
		});
		expect((await readRequestBody<{ minLat: number }>(request)).minLat).toBe(1.5);
	});

	// msgpack has no undefined: an absent optional field encodes as nil and decodes
	// to null, which passes `since !== undefined` and appends `updated > NULL` to the
	// query — matching no rows at all.
	it("drops nulls so absent optionals stay undefined", async () => {
		const request = msgpackRequest({ minLat: 1, since: undefined, filter: undefined });
		const body = await readRequestBody<{ since?: number; filter?: unknown }>(request);

		expect(body.since).toBeUndefined();
		expect(body.filter).toBeUndefined();
		expect("since" in body).toBe(false);
	});

	it("drops nulls nested in arrays and objects", async () => {
		const request = msgpackRequest({ subs: [{ type: "pokemon", since: undefined }] });
		const body = await readRequestBody<{ subs: { since?: number }[] }>(request);

		expect(body.subs[0]!.since).toBeUndefined();
		expect("since" in body.subs[0]!).toBe(false);
	});

	it("keeps a real since value", async () => {
		const request = msgpackRequest({ since: 1700000000 }, { ignoreUndefined: true });
		expect((await readRequestBody<{ since?: number }>(request)).since).toBe(1700000000);
	});
});
