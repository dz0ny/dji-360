// `/~/api/terrain/<id>` — the ground around one panorama, as plain heights.

// The peak labels hide a summit when a nearer named summit stands in front of
// it. An unnamed hill in front hid nothing, so labels landed on its slope. On
// Mali vrhek, Veje sat on the wooded hill a few hundred metres away.

// This endpoint answers with a ring of ground heights. It samples 360 bearings
// at 30 distances out to 15 km. The browser turns those heights into angles,
// because the angle depends on how high the drone flew. The cache holds facts
// about the ground, as `peaks.js` does, and never one view of them.

// The heights come from the public Terrarium tiles on AWS. They need no key and
// no quota. Each tile is a PNG with the height packed into its colour channels.

const ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;

/** Zoom 11 is about 53 m a pixel at this latitude, fine enough for a hill. */
const ZOOM = 11;
const TILE = 256;
const TILE_URL = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;

/** One sample a degree, so a narrow summit still has its own column. */
const BEARINGS = 360;

// Distances grow by a fixed ratio. The near ground hides the most sky, and it
// needs the dense samples. Beyond 15 km a named summit is the usual cover,
// and the existing check handles that.
const NEAREST = 150;
const FARTHEST = 15000;
const STEPS = 30;
const DISTANCES = Array.from({ length: STEPS }, (_, i) =>
	Math.round(NEAREST * (FARTHEST / NEAREST) ** (i / (STEPS - 1))),
);

const R = 6371008.8;
const DEG = Math.PI / 180;

/** A year, and immutable: the ground does not move, and a version bump changes the key. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const VERSION = 1;

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
	});

const fail = (status, message) => json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/** The point `distance` metres away along `bearing`, on a sphere. */
function destination(lat, lon, bearing, distance) {
	const φ1 = lat * DEG;
	const λ1 = lon * DEG;
	const θ = bearing * DEG;
	const δ = distance / R;
	const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
	const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
	return { lat: φ2 / DEG, lon: λ2 / DEG };
}

/** Web Mercator, in pixels of the whole world at `ZOOM`. */
function worldPixel(lat, lon) {
	const size = TILE * 2 ** ZOOM;
	const φ = lat * DEG;
	return {
		x: ((lon + 180) / 360) * size,
		y: ((1 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / Math.PI) / 2) * size,
	};
}

// Decode a Terrarium tile.

// A Worker has no canvas, so this reads the PNG by hand. The tiles are always
// 8-bit RGB or RGBA and never interlaced, and anything else fails loudly. The
// zlib stream inside a PNG is the format `DecompressionStream('deflate')` reads.
async function decodePng(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat = [];

	for (let pos = 8; pos < bytes.length; ) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		if (type === 'IHDR') {
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			const depth = bytes[pos + 16];
			const colour = bytes[pos + 17];
			const interlace = bytes[pos + 20];
			if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) {
				throw new Error(`unexpected PNG format (depth ${depth}, colour ${colour}, interlace ${interlace})`);
			}
			channels = colour === 2 ? 3 : 4;
		} else if (type === 'IDAT') {
			idat.push(bytes.subarray(pos + 8, pos + 8 + length));
		} else if (type === 'IEND') {
			break;
		}
		pos += 12 + length;
	}

	const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
	const raw = new Uint8Array(await new Response(stream).arrayBuffer());

	// Undo the per-row filters. Each row starts with a filter byte, and each
	// filter predicts a byte from its left, upper and upper-left neighbours.
	const stride = width * channels;
	const pixels = new Uint8Array(height * stride);
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)];
		const src = row * (stride + 1) + 1;
		const out = row * stride;
		const up = out - stride;
		for (let i = 0; i < stride; i++) {
			const left = i >= channels ? pixels[out + i - channels] : 0;
			const above = row > 0 ? pixels[up + i] : 0;
			const corner = row > 0 && i >= channels ? pixels[up + i - channels] : 0;
			let predicted = 0;
			if (filter === 1) predicted = left;
			else if (filter === 2) predicted = above;
			else if (filter === 3) predicted = (left + above) >> 1;
			else if (filter === 4) {
				const p = left + above - corner;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - above);
				const pc = Math.abs(p - corner);
				predicted = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
			}
			pixels[out + i] = (raw[src + i] + predicted) & 0xff;
		}
	}

	return { width, channels, pixels };
}

/** Terrarium packs metres as R·256 + G + B/256, offset by 32768. */
function heightAt(tile, px, py) {
	const i = (py * tile.width + px) * tile.channels;
	return tile.pixels[i] * 256 + tile.pixels[i + 1] + tile.pixels[i + 2] / 256 - 32768;
}

async function terrainRing(lat, lon) {
	// Work out every sample first, so each tile downloads once.
	const samples = [];
	const tiles = new Map();
	for (let b = 0; b < BEARINGS; b++) {
		for (const distance of DISTANCES) {
			const point = destination(lat, lon, b, distance);
			const { x, y } = worldPixel(point.lat, point.lon);
			const key = `${Math.floor(x / TILE)}/${Math.floor(y / TILE)}`;
			tiles.set(key, null);
			samples.push({ key, px: Math.floor(x) % TILE, py: Math.floor(y) % TILE });
		}
	}

	await Promise.all(
		[...tiles.keys()].map(async (key) => {
			const [x, y] = key.split('/').map(Number);
			const res = await fetch(TILE_URL(x, y), { cf: { cacheTtl: 2592000, cacheEverything: true } });
			if (!res.ok) throw new Error(`terrain tile ${key} answered ${res.status}`);
			tiles.set(key, await decodePng(new Uint8Array(await res.arrayBuffer())));
		}),
	);

	const ele = [];
	for (let b = 0; b < BEARINGS; b++) {
		const row = [];
		for (let d = 0; d < STEPS; d++) {
			const sample = samples[b * STEPS + d];
			row.push(Math.round(heightAt(tiles.get(sample.key), sample.px, sample.py)));
		}
		ele.push(row);
	}
	return { tiles: tiles.size, ele };
}

// `GET /~/api/terrain/<id>`, public like the peaks it serves.

// The same three caches as `peaks.js`: the edge, then R2, then the tiles. A
// failure caches nothing, and the page then labels peaks as it did before.
export async function handleTerrain(request, env, id) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');
	if (!ID_RE.test(id)) return fail(400, 'Invalid photo id');

	const cacheKey = `terrain/cache/${id}.v${VERSION}.json`;
	const edge = caches.default;
	const edgeKey = new Request(new URL(`/~/api/terrain/${id}?v=${VERSION}`, request.url), { method: 'GET' });
	const edgeHit = await edge.match(edgeKey);
	if (edgeHit) return edgeHit;

	const cached = await env.PHOTOS.get(cacheKey);
	if (cached) {
		const response = new Response(cached.body, {
			headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': CACHE_CONTROL },
		});
		await edge.put(edgeKey, response.clone());
		return response;
	}

	const thumb = await env.PHOTOS.head(`thumbs/${id}`);
	if (!thumb) return fail(404, 'Not found');

	const lat = Number(thumb.customMetadata?.lat);
	const lon = Number(thumb.customMetadata?.lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail(422, 'This panorama has no coordinates');

	let ring;
	try {
		ring = await terrainRing(lat, lon);
	} catch (error) {
		return fail(503, `Could not read the terrain (${error.message})`);
	}

	const payload = { lat, lon, bearings: BEARINGS, distances: DISTANCES, ele: ring.ele };
	await env.PHOTOS.put(cacheKey, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	});

	const response = json(payload, { headers: { 'Cache-Control': CACHE_CONTROL } });
	await edge.put(edgeKey, response.clone());
	return response;
}
