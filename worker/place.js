/**
 * `/~/api/place?lat=&lon=` — what a human would call this spot.
 *
 * A panorama arrives with coordinates and no name. Nominatim turns the first
 * into the second, and this route is where that happens: in the Worker rather
 * than the browser, because OSM's usage policy asks clients to identify
 * themselves and a page cannot set its own `User-Agent`.
 *
 * Answers are cached in R2 alongside the photos, keyed to ~110 m. Twenty flights
 * over the same valley are one lookup, and a spot with no name is cached too —
 * otherwise every empty answer would be re-asked forever.
 *
 * Behind the Access check, like every other write-side route: the archive owner
 * names their own photos, and an open geocoding proxy is somebody else's rate
 * limit to burn.
 */

import { bakedPeaks, haversine } from './peaks.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Zoom 14 is Nominatim's "suburb / village" rung. Lower and a mountain flight
 * comes back as the county; higher and it starts naming individual buildings,
 * which is not what a panorama shot 400 m up is of.
 */
const ZOOM = 14;

/** ~110 m. Two flights from the same meadow should not be two lookups. */
const CACHE_PRECISION = 3;

const CACHE_PREFIX = 'places/';

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(init.headers || {}) },
	});

const fail = (status, message) => json({ error: message }, { status });

/**
 * Most specific first. A settlement beats the municipality that contains it,
 * and the municipality beats the county — the aim is the name someone standing
 * there would use, not the most administratively correct one.
 */
const ADDRESS_KEYS = [
	'hamlet',
	'isolated_dwelling',
	'village',
	'suburb',
	'town',
	'city_district',
	'city',
	'municipality',
	'county',
	'state',
];

/**
 * Named landscape beats named settlement. A drone over Snežnik is over Snežnik,
 * even though the nearest addressable thing is a village down in the valley.
 */
const NATURAL_CATEGORIES = new Set(['natural', 'waterway', 'place']);
const NATURAL_TYPES = new Set(['peak', 'ridge', 'volcano', 'massif', 'water', 'bay', 'lake', 'glacier', 'valley', 'island', 'islet']);

function pickName(result) {
	if (!result || typeof result !== 'object') return '';

	// `name` is the feature actually under the pin, when there is one.
	const feature = typeof result.name === 'string' ? result.name.trim() : '';
	if (feature && (NATURAL_TYPES.has(result.type) || NATURAL_CATEGORIES.has(result.category))) return feature;

	const address = result.address || {};
	for (const key of ADDRESS_KEYS) {
		const value = address[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}

	// Nothing administrative either — fall back to whatever was named at all.
	return feature;
}

/**
 * How close the drone has to be to a named top for the top to be the answer.
 *
 * This archive is mountain work, and Nominatim will never give you a summit —
 * asked about Snežnik it returns the municipality 15 km down the valley, or, at
 * a tighter zoom, the forest track under the trees. The baked peak index the
 * horizon labels already run on knows the name; it just has to be asked whether
 * the drone was actually over one. 400 m is close enough that the summit is the
 * subject rather than something in the distance.
 */
const SUMMIT_RADIUS_M = 400;

/** The named top the drone was standing on, if it was standing on one. */
async function summitAt(env, lat, lon) {
	let peaks;
	try {
		peaks = await bakedPeaks(env, lat, lon);
	} catch {
		// The index is an optimisation for the horizon labels, not a dependency
		// of naming — a bad read just means Nominatim answers instead.
		return '';
	}
	if (!peaks?.length) return '';

	let best = null;
	let bestDistance = SUMMIT_RADIUS_M;
	for (const peak of peaks) {
		if (!peak?.name) continue;
		const distance = haversine(lat, lon, peak.lat, peak.lon);
		if (distance < bestDistance) {
			best = peak;
			bestDistance = distance;
		}
	}

	return best ? best.name : '';
}

async function lookup(lat, lon) {
	const url = new URL(ENDPOINT);
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('lat', String(lat));
	url.searchParams.set('lon', String(lon));
	url.searchParams.set('zoom', String(ZOOM));
	url.searchParams.set('addressdetails', '1');

	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			// Nominatim's policy: an unnamed client is the first one blocked.
			'User-Agent': 'dji.dz0ny.dev panorama naming (+https://dji.dz0ny.dev)',
		},
	});

	if (!res.ok) throw new Error(`Nominatim replied ${res.status}`);

	const body = await res.json();
	return {
		name: pickName(body),
		// The full string is only ever shown to whoever is naming the photo, so
		// they can see what the coordinates actually resolved to.
		display: typeof body.display_name === 'string' ? body.display_name : '',
	};
}

export async function handlePlace(request, env) {
	if (request.method !== 'GET') return fail(405, 'Method not allowed');

	const params = new URL(request.url).searchParams;
	const lat = Number(params.get('lat'));
	const lon = Number(params.get('lon'));

	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		return fail(400, 'lat and lon are required');
	}

	const key = `${CACHE_PREFIX}${lat.toFixed(CACHE_PRECISION)},${lon.toFixed(CACHE_PRECISION)}.json`;

	const cached = await env.PHOTOS.get(key);
	if (cached) return json({ ...(await cached.json()), cached: true });

	// A summit beats an address. Everything else falls through to Nominatim.
	const summit = await summitAt(env, lat, lon);
	if (summit) {
		const place = { name: summit, display: `${summit} — nearest named summit` };
		await env.PHOTOS.put(key, JSON.stringify(place), {
			httpMetadata: { contentType: 'application/json; charset=utf-8' },
		});
		return json({ ...place, cached: false });
	}

	let place;
	try {
		place = await lookup(lat, lon);
	} catch (error) {
		// A naming service being down must never be fatal to whoever is uploading;
		// the caller falls back to leaving the title blank.
		return fail(502, error instanceof Error ? error.message : 'Reverse geocoding failed');
	}

	// Cached whether or not a name came back: an unnamed spot stays unnamed, and
	// re-asking every time would only spend someone else's rate limit.
	await env.PHOTOS.put(key, JSON.stringify(place), {
		httpMetadata: { contentType: 'application/json; charset=utf-8' },
	});

	return json({ ...place, cached: false });
}
