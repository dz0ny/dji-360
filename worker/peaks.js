/**
 * `/~/api/peaks/<id>` — the named summits around one panorama.
 *
 * The summits themselves come from a baked index in R2: `bun run peaks` walks a
 * bounding box over Overpass once, fills the heights OSM never recorded, and
 * writes the result as a grid of one-degree cells. A panorama inside that box
 * therefore costs two bucket reads rather than the ~35 seconds of rate-limited
 * Overpass the live query used to take — and it cannot 504. Coordinates outside
 * the baked box still fall back to the live lookup, so a photo from somewhere
 * new is never label-less; re-run the bake to make it fast.
 *
 * Open-Meteo still answers one question at request time: the ground under the
 * drone. DJI records height above the take-off point, which is no use for an
 * angle to a mountain 20 km away.
 *
 * The maths — bearings, angles, what is hidden behind what — is deliberately not
 * here: it belongs next to the viewer, in `src/lib/peaks.ts`, so the cache holds
 * plain facts about the world rather than one page's interpretation of them.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;

/** Far enough for a big alpine horizon, near enough that Overpass stays quick. */
const RADIUS_M = 60000;

/**
 * Overpass answers with everything — 5000+ summits inside 60 km of the Julian
 * Alps — and the browser has to download whatever we cache. The cap is applied
 * by apparent size from the viewpoint rather than raw elevation, so a 900 m hill
 * two kilometres away outranks a 2400 m one at the far edge of the circle. It is
 * the same ordering the eye uses.
 */
const MAX_PEAKS = 600;

/**
 * How many summits without an `ele` tag we are willing to look up. Open-Meteo
 * takes 100 coordinates per request, so this is five round trips at worst — the
 * price of a first load, paid once and then cached forever.
 */
const MAX_ELEVATION_LOOKUPS = 500;

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
	});

const fail = (status, message) => json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/** OSM `ele` is free text: "1796", "1796 m", "1,796", occasionally nonsense. */
function toElevation(raw) {
	if (typeof raw !== 'string') return null;
	const value = Number.parseFloat(raw.replace(',', '.'));
	return Number.isFinite(value) && value > -500 && value < 9000 ? value : null;
}

async function fetchPeaks(lat, lon) {
	// `hill` and `volcano` alongside `peak`: the mapper's choice between "peak"
	// and "hill" is a judgement about the landscape, not about whether the thing
	// is worth naming on a horizon — and in this part of the world the 600–900 m
	// wooded tops that fill the middle distance are mostly tagged `hill`.
	const query = `[out:json][timeout:25];node(around:${RADIUS_M},${lat},${lon})["natural"~"^(peak|hill|volcano)$"]["name"];out qt;`;

	let lastError;
	for (const endpoint of OVERPASS_ENDPOINTS) {
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				body: `data=${encodeURIComponent(query)}`,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					// Overpass asks that clients identify themselves, and an unnamed
					// client is the first one throttled when the instance is busy.
					'User-Agent': 'dji.dz0ny.dev peak labels (+https://dji.dz0ny.dev)',
				},
			});
			if (!res.ok) {
				lastError = new Error(`Overpass replied ${res.status}`);
				continue;
			}

			const body = await res.json();
			const peaks = [];
			for (const element of body.elements || []) {
				const name = element.tags?.name;
				if (!name || element.lat == null) continue;
				// A missing `ele` is the norm on smaller tops, and dropping them was why
				// the horizon only ever showed the famous mountains. Kept with a null
				// height, and filled in below from a terrain model.
				peaks.push({ name, lat: element.lat, lon: element.lon, ele: toElevation(element.tags?.ele) });
			}

			return peaks;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error('Overpass unreachable');
}

const DEG = Math.PI / 180;
const R = 6371008.8;

/** Great-circle distance in metres. */
function haversine(lat1, lon1, lat2, lon2) {
	const dLat = (lat2 - lat1) * DEG;
	const dLon = (lon2 - lon1) * DEG;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Where `scripts/bake-peaks.mjs` writes the pre-built index. */
const GRID_PREFIX = 'peaks/grid/v1/';

/**
 * The manifest, memoised for the life of the isolate. It is a few kilobytes and
 * changes only when the bake is re-run, so re-reading it per request would be
 * pure ceremony. A miss is cached as `null` too — a bucket with no baked index
 * must not cost a lookup on every single request.
 */
let manifestPromise;

function loadManifest(env) {
	manifestPromise ??= env.PHOTOS.get(`${GRID_PREFIX}index.json`)
		.then((object) => (object ? object.json() : null))
		.catch(() => null);
	return manifestPromise;
}

/**
 * The baked summits within `RADIUS_M` of a point, or null when the point (or
 * any part of its horizon) falls outside the baked box — in which case the
 * caller goes to Overpass rather than serving a horizon with a hole in it.
 */
async function bakedPeaks(env, lat, lon) {
	const manifest = await loadManifest(env);
	if (!manifest?.cells?.length) return null;

	const [minLat, minLon, maxLat, maxLon] = manifest.bbox;
	// The circle, not just the centre: a photo one kilometre inside the edge can
	// still see 60 km past it, and half a horizon is worse than a slow one.
	const latPad = RADIUS_M / 111320;
	const lonPad = RADIUS_M / (111320 * Math.max(0.1, Math.cos(lat * DEG)));
	if (lat - latPad < minLat || lat + latPad > maxLat || lon - lonPad < minLon || lon + lonPad > maxLon) return null;

	const covered = new Set(manifest.cells);
	const keys = [];
	for (let latCell = Math.floor(lat - latPad); latCell <= Math.floor(lat + latPad); latCell++) {
		for (let lonCell = Math.floor(lon - lonPad); lonCell <= Math.floor(lon + lonPad); lonCell++) {
			// An absent cell is a cell with no named tops in it — the bake skips
			// those rather than writing empty objects.
			if (covered.has(`${latCell}_${lonCell}`)) keys.push(`${GRID_PREFIX}${latCell}_${lonCell}.json`);
		}
	}

	const cells = await Promise.all(keys.map((key) => env.PHOTOS.get(key).then((object) => (object ? object.json() : []))));
	const peaks = [];
	for (const cell of cells) {
		for (const peak of cell) {
			if (haversine(lat, lon, peak.lat, peak.lon) <= RADIUS_M) peaks.push(peak);
		}
	}
	return peaks;
}

/**
 * Keep the summits that would actually catch the eye.
 *
 * Ranking by the angle a peak subtends from the viewpoint — height above the
 * observer over distance — is a crude stand-in for what the browser computes
 * properly, but it only has to be good enough to decide what is worth caching.
 */
function rankByApparentSize(peaks, lat, lon, eyeEle) {
	for (const peak of peaks) {
		peak.distance = haversine(lat, lon, peak.lat, peak.lon);
		peak.rank = (peak.ele - eyeEle) / Math.max(peak.distance, 500);
	}
	peaks.sort((a, b) => b.rank - a.rank);
	// The distance and rank were scaffolding for this sort; the client recomputes
	// both against the real camera position, so they do not go in the cache.
	return peaks.slice(0, MAX_PEAKS).map(({ name, lat: pLat, lon: pLon, ele }) => ({ name, lat: pLat, lon: pLon, ele }));
}

/**
 * Fill in the heights OSM never recorded.
 *
 * Open-Meteo will sample its terrain model at 100 coordinates per request, so
 * the unnamed-height problem costs a handful of round trips rather than one per
 * summit. The nearest tops are filled first: those are the ones that dominate a
 * frame, and a 700 m hill three kilometres away matters more to the horizon than
 * a nameless bump at the far edge of the circle.
 */
async function fillMissingElevations(peaks, lat, lon) {
	const missing = peaks
		.filter((peak) => peak.ele == null)
		.map((peak) => ({ peak, distance: haversine(lat, lon, peak.lat, peak.lon) }))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, MAX_ELEVATION_LOOKUPS)
		.map((entry) => entry.peak);

	for (let i = 0; i < missing.length; i += 100) {
		const batch = missing.slice(i, i + 100);
		const latitudes = batch.map((peak) => peak.lat.toFixed(5)).join(',');
		const longitudes = batch.map((peak) => peak.lon.toFixed(5)).join(',');
		try {
			const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latitudes}&longitude=${longitudes}`);
			if (!res.ok) break;
			const body = await res.json();
			const values = body?.elevation;
			if (!Array.isArray(values)) break;
			batch.forEach((peak, index) => {
				const value = values[index];
				if (Number.isFinite(value)) peak.ele = value;
			});
		} catch {
			// A partial fill is still better than none: whatever was resolved before
			// the failure stays, and the rest fall out of the list below.
			break;
		}
	}

	// The terrain model puts a summit a few metres low — it samples a grid cell,
	// not the cairn — but the alternative is no label at all.
	return peaks.filter((peak) => peak.ele != null);
}

/**
 * Ground level under the panorama. Null is survivable — the client then treats
 * the recorded altitude as absolute — so a flaky elevation service must not take
 * the whole lookup down with it.
 */
async function fetchGroundElevation(lat, lon) {
	try {
		const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
		if (!res.ok) return null;
		const body = await res.json();
		const value = body?.elevation?.[0];
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/**
 * How long a browser or an edge node may keep an answer.
 *
 * A year, and immutable with it. The answer describes a fixed point on the
 * earth, so the only thing that can change it is us changing our minds about
 * what to ask for — and that bumps the version in the key below, which changes
 * the URL's answer wholesale rather than waiting for a TTL to lapse. Deleting
 * the R2 object forces a re-lookup for anyone who has not cached it.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * `GET /~/api/peaks/<id>` — public, like the gallery listing it belongs to.
 *
 * Three caches deep, cheapest first: the Cloudflare edge cache, then the R2
 * object, and only then the ~35 seconds of Overpass and elevation lookups that
 * built it. The browser's own HTTP cache sits in front of all three.
 */
export async function handlePeaks(request, env, id) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');
	if (!ID_RE.test(id)) return fail(400, 'Invalid photo id');

	// v3 reads the baked index, which is a wider and more consistent answer than
	// the live query gave. Older objects are a strictly smaller answer, so they
	// get a new key rather than a migration — and the key moved under
	// `peaks/cache/` so it cannot collide with the baked grid.
	const cacheKey = `peaks/cache/${id}.v3.json`;

	// A colocated cache entry, so a second visitor in the same city never even
	// reaches the bucket. Keyed on the version too: a bump must not serve the
	// old answer from the edge.
	const edge = caches.default;
	const edgeKey = new Request(new URL(`/~/api/peaks/${id}?v=3`, request.url), { method: 'GET' });
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

	const meta = thumb.customMetadata || {};
	const lat = Number(meta.lat);
	const lon = Number(meta.lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return fail(422, 'This panorama has no coordinates');

	let peaks;
	let groundEle;
	try {
		let baked;
		[baked, groundEle] = await Promise.all([bakedPeaks(env, lat, lon), fetchGroundElevation(lat, lon)]);
		if (baked) {
			// The bake already filled every missing height; anything without one
			// was dropped there rather than being carried into the bucket.
			peaks = baked;
		} else {
			peaks = await fillMissingElevations(await fetchPeaks(lat, lon), lat, lon);
		}
	} catch (error) {
		// Nothing is cached on failure, so a retry is a real retry.
		return fail(503, `Could not reach the summit database (${error.message})`);
	}

	// Ranking only needs a rough eye height; the drone's own altitude is a detail
	// the client applies later, and near enough for deciding what to keep.
	const payload = {
		lat,
		lon,
		radius: RADIUS_M,
		groundEle,
		peaks: rankByApparentSize(peaks, lat, lon, groundEle ?? 0),
	};

	await env.PHOTOS.put(cacheKey, JSON.stringify(payload), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	});

	const response = json(payload, { headers: { 'Cache-Control': CACHE_CONTROL } });
	await edge.put(edgeKey, response.clone());
	return response;
}
