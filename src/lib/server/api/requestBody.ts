import { decode } from "@msgpack/msgpack";

/**
 * Bounds on what a single body may decode to. msgpack states a collection's
 * length up front and the decoder allocates for it before reading any element,
 * so without these a five-byte body declaring a 33M-element array allocates
 * hundreds of megabytes before failing. JSON has no equivalent amplification.
 *
 * These are far above any real request: a poll body is a bounding box, a
 * timestamp and a hash, and the largest filter the server will even cache is
 * 16 KB.
 */
const DECODE_LIMITS = {
	maxArrayLength: 100_000,
	maxMapLength: 100_000,
	maxStrLength: 64 * 1024,
	maxBinLength: 64 * 1024,
	maxExtLength: 64 * 1024
};

/** Nesting beyond this is rejected rather than recursed into. Filters nest ~6 deep. */
const MAX_DEPTH = 64;

/**
 * Raw bytes buffered before decoding. The decode ceilings above can't apply
 * until the whole body is in memory, so this is what actually bounds that.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Read a request body as msgpack or JSON, depending on its Content-Type.
 * Clients send msgpack where they can — it is roughly half the size of the
 * equivalent JSON and request bodies are never compressed by the browser.
 */
export async function readRequestBody<T>(request: Request): Promise<T> {
	const contentType = request.headers.get("Content-Type") ?? "";

	const declared = Number(request.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw new Error("Request body too large");
	}

	if (!contentType.includes("application/msgpack")) return (await request.json()) as T;

	const raw = new Uint8Array(await request.arrayBuffer());
	if (raw.byteLength > MAX_BODY_BYTES) throw new Error("Request body too large");

	const body = decode(raw, DECODE_LIMITS);

	// msgpack has no undefined, so an absent optional field arrives as null and
	// would defeat `!== undefined` guards such as the `since` delta cursor. Only
	// the msgpack path needs this: in JSON an absent field is genuinely absent,
	// so a null there was written deliberately.
	dropNulls(body, 0);
	return body as T;
}

function dropNulls(value: unknown, depth: number): void {
	if (!value || typeof value !== "object") return;
	if (depth >= MAX_DEPTH) throw new Error("Request body nested too deeply");

	if (Array.isArray(value)) {
		for (const item of value) dropNulls(item, depth + 1);
		return;
	}

	for (const [key, entry] of Object.entries(value)) {
		if (entry === null) delete (value as Record<string, unknown>)[key];
		else dropNulls(entry, depth + 1);
	}
}
