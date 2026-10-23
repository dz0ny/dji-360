/**
 * Turning a list of summits into labels on a sphere.
 *
 * The Worker hands back plain facts — name, position, elevation — and every
 * judgement about where a peak *appears* is made here, in the browser, because
 * it depends on the viewer: where the camera was, how high it flew, and which
 * way it was pointing.
 *
 * Three corrections separate a naive bearing from a label that lands on the
 * right mountain:
 *
 *   Curvature   over 40 km the earth drops ~125 m; ignoring it lifts distant
 *               summits well above where they really sit in the frame.
 *   Refraction  the atmosphere bends light back down, returning about 13% of
 *               that drop. The standard dodge is an "effective radius" of
 *               R / (1 − k), which folds both into one number.
 *   Occlusion   OSM will happily hand you 400 summits, most of them behind the
 *               ridge in front of them. Anything a nearer, higher peak stands
 *               in front of is dropped rather than drawn over solid rock.
 */

import { API } from "@/config";

/** Mean earth radius, metres (IUGG). */
const R = 6371008.8;

/** Standard atmospheric refraction coefficient for daylight over land. */
const K = 0.13;

/** Radius that already contains the refraction correction. */
const R_EFF = R / (1 - K);

const DEG = Math.PI / 180;

/** A summit exactly as OpenStreetMap has it. */
export interface PeakSource {
	name: string;
	lat: number;
	lon: number;
	/** Metres above sea level. */
	ele: number;
}

export interface PeaksPayload {
	lat: number;
	lon: number;
	radius: number;
	/** Ground level under the panorama, metres above sea level. Null if unknown. */
	groundEle: number | null;
	peaks: PeakSource[];
}

/** A summit placed relative to one particular viewpoint. */
export interface PlacedPeak extends PeakSource {
	/** Metres, great-circle. */
	distance: number;
	/** Degrees clockwise from true north. */
	bearing: number;
	/** Degrees above (+) or below (−) the horizontal, as seen from the camera. */
	angle: number;
	/** How far the summit stands above the camera, in metres. */
	relief: number;
	/** N, NNE, NE… — useful even when the sphere's heading is unknown. */
	compass: string;
	/**
	 * Which row to draw the label in, 0 being closest to the summit. Peaks that
	 * sit near each other in bearing get different tiers so their plates stack
	 * up the sky instead of landing on top of one another.
	 */
	tier: number;
	/**
	 * Position in the ranking, 0 being the most striking summit in the frame.
	 * When two plates still collide on screen — which depends on the zoom, and
	 * so cannot be settled here — this is who wins.
	 */
	rank: number;
}

const COMPASS = [
	"N",
	"NNE",
	"NE",
	"ENE",
	"E",
	"ESE",
	"SE",
	"SSE",
	"S",
	"SSW",
	"SW",
	"WSW",
	"W",
	"WNW",
	"NW",
	"NNW",
];

export function compassLabel(bearing: number): string {
	return COMPASS[Math.round(normalizeDegrees(bearing) / 22.5) % 16];
}

export function normalizeDegrees(value: number): number {
	return ((value % 360) + 360) % 360;
}

/** Signed difference a − b, folded into ±180. */
export function bearingDelta(a: number, b: number): number {
	return ((((a - b) % 360) + 540) % 360) - 180;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = (lat2 - lat1) * DEG;
	const dLon = (lon2 - lon1) * DEG;
	const a =
		Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const φ1 = lat1 * DEG;
	const φ2 = lat2 * DEG;
	const Δλ = (lon2 - lon1) * DEG;
	const y = Math.sin(Δλ) * Math.cos(φ2);
	const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
	return normalizeDegrees(Math.atan2(y, x) / DEG);
}

export interface ViewpointOptions {
	/** Metres above sea level, if the camera recorded it. */
	altitudeAmsl?: number | null;
	/** Metres above the take-off point — DJI's default datum. */
	altitude?: number | null;
	/** How many labels to keep. Past ~40 the horizon turns into a wall of text. */
	limit?: number;
	/** Ignore anything nearer than this; a summit 300 m away is scenery, not a label. */
	minDistance?: number;
	/** The ground around the camera. Without it, only named summits can hide a peak. */
	terrain?: TerrainRing | null;
}

/** Ground heights on a ring of bearings and distances, from `/~/api/terrain/<id>`. */
export interface TerrainRing {
	bearings: number;
	/** Metres from the camera, nearest first. */
	distances: number[];
	/** `ele[bearing][step]`, metres above sea level. */
	ele: number[][];
}

// Where the ground check stops, and how high the ground must rise to hide a
// summit.

// The check stops short of the summit, at 80% of its distance. The DEM smooths
// a summit into its shoulders, and a shoulder near the top must not hide it.
// The margin absorbs the error of a 53 m grid against a surveyed OSM height.
export const GROUND_REACH = 0.8;
const GROUND_MARGIN = 0.3;

/**
 * How the labels are spread and stacked.
 *
 * The horizon is cut into sectors and each one gets a label before any sector
 * gets a second, which is what stops a range of famous 2000ers in the north
 * taking every slot while the wooded tops filling the other 270° go unnamed.
 * `MIN_SEPARATION` then keeps two labels off the same spot, and `TIER_WINDOW`
 * decides how close in bearing two plates have to be before the second one is
 * lifted into the row above.
 */
const SECTORS = 24;
const MIN_SEPARATION = 2.5;
const TIER_WINDOW = 9;
const TIERS = 3;

// Camera height above sea level.

// The ground under the panorama plus the height above take-off comes first. A
// panorama hovers over the spot it took off from, so the sum is right to a few
// metres. The barometric height above take-off is the steadiest figure DJI
// records.

// The recorded sea-level figure comes second, and only when it clears the
// ground. Across this archive it runs from 583 m too low to 300 m too high
// against that sum. Five frames put the camera underground. Kucelj and Iga vas
// share 1000.894 m to the millimetre, as do Grohari and Gorači at 1042.664 m.
// A camera underground hid every summit behind the ground in front of it.

// Older records kept one field for both. The same value in both slots names
// no datum. It counts as sea level only when it clears the ground. It never
// counts as a height above take-off.
export function eyeElevation(payload: PeaksPayload, options: ViewpointOptions): number | null {
	const ground = payload.groundEle;
	const amsl =
		options.altitudeAmsl != null && Number.isFinite(options.altitudeAmsl)
			? options.altitudeAmsl
			: null;
	const relative =
		options.altitude != null && Number.isFinite(options.altitude) ? options.altitude : null;
	const oneField = amsl != null && relative != null && amsl === relative;

	if (
		!oneField &&
		ground != null &&
		relative != null &&
		relative > 0 &&
		relative <= MAX_FLIGHT_HEIGHT
	) {
		return ground + relative;
	}

	const recorded = amsl ?? (relative != null && relative > MAX_FLIGHT_HEIGHT ? relative : null);
	if (recorded != null && (ground == null || recorded > ground)) return recorded;

	return ground;
}

/** DJI caps the height above take-off at 500 m, so a larger figure is sea level. */
const MAX_FLIGHT_HEIGHT = 500;

// The ground height at one point of the ring, for anything placed on it.

// The arrows to other panoramas need the ground under the other drone. The
// ring holds it for every bearing out to 15 km. Nearer than the first sample,
// the first sample stands in.
export function groundAt(terrain: TerrainRing, bearing: number, distance: number): number | null {
	const column = terrain.ele[Math.round(normalizeDegrees(bearing)) % terrain.bearings];
	if (!column) return null;
	let best = 0;
	for (let i = 1; i < terrain.distances.length; i++) {
		if (Math.abs(terrain.distances[i] - distance) < Math.abs(terrain.distances[best] - distance))
			best = i;
	}
	return distance > terrain.distances[terrain.distances.length - 1] ? null : column[best];
}

/**
 * Apparent angle to a point, in degrees, with curvature and refraction folded in.
 */
function apparentAngle(targetEle: number, eyeEle: number, distance: number): number {
	const drop = (distance * distance) / (2 * R_EFF);
	return Math.atan2(targetEle - eyeEle - drop, distance) / DEG;
}

/** How far below horizontal the true horizon sits, for a camera this high. */
export function horizonAngle(eyeEle: number): number {
	return -Math.sqrt((2 * Math.max(eyeEle, 1)) / R_EFF) / DEG;
}

// Does the ground between here and the summit rise in front of it?

// The check reads the one ring column nearest the summit's bearing. A summit
// hidden this way is behind a hill that OSM never named.
function hiddenByGround(terrain: TerrainRing, peak: PlacedPeak, eyeEle: number): boolean {
	return groundHides(terrain, peak, eyeEle, peak.distance * GROUND_REACH);
}

// Does the ground rise above a direction before `reach` metres?

// The same test for anything seen from the camera: a summit, another drone, or
// the sun. The sun is infinitely far, so its reach is the whole ring.
export function groundHides(
	terrain: TerrainRing,
	direction: { bearing: number; angle: number },
	eyeEle: number,
	reach: number,
): boolean {
	const column = terrain.ele[Math.round(normalizeDegrees(direction.bearing)) % terrain.bearings];
	if (!column) return false;
	for (let i = 0; i < terrain.distances.length; i++) {
		const distance = terrain.distances[i];
		if (distance >= reach) break;
		if (apparentAngle(column[i], eyeEle, distance) > direction.angle + GROUND_MARGIN) return true;
	}
	return false;
}

/**
 * Would a nearer summit stand in front of this one?
 *
 * A cheap stand-in for a real terrain profile: treat each peak as the tip of a
 * massif roughly 3 km wide and ask whether anything closer, inside that angular
 * window, reaches higher in the frame. It over-hides slightly on narrow spires
 * and under-hides where the ridge is broad — but it removes the great mass of
 * summits that are unambiguously behind something, which is the whole point.
 */
function isOccluded(peak: PlacedPeak, nearer: PlacedPeak[]): boolean {
	const halfWidth = Math.max(0.6, Math.atan(1500 / peak.distance) / DEG);
	for (const other of nearer) {
		if (other.distance >= peak.distance) break;
		if (Math.abs(bearingDelta(other.bearing, peak.bearing)) > halfWidth) continue;
		if (other.angle >= peak.angle) return true;
	}
	return false;
}

/**
 * Place every summit relative to the panorama, drop the ones that cannot be
 * seen, and keep the most striking of what remains.
 *
 * Returned in bearing order, so a list of them reads as a sweep of the horizon
 * rather than a ranking.
 */
export function placePeaks(payload: PeaksPayload, options: ViewpointOptions = {}): PlacedPeak[] {
	const eyeEle = eyeElevation(payload, options);
	if (eyeEle == null) return [];

	const minDistance = options.minDistance ?? 400;
	const horizon = horizonAngle(eyeEle);

	const placed: PlacedPeak[] = [];
	for (const peak of payload.peaks) {
		const distance = haversine(payload.lat, payload.lon, peak.lat, peak.lon);
		if (distance < minDistance) continue;

		const angle = apparentAngle(peak.ele, eyeEle, distance);
		// Below the horizon line means beyond it, but only far away. A near hill
		// below the drone is plainly in view, and the camera looks down on it.
		// Inside the reach of the ground ring, the ring decides instead.
		const ringReach = options.terrain?.distances.at(-1) ?? 0;
		if (angle < horizon && distance > ringReach) continue;

		const bearing = initialBearing(payload.lat, payload.lon, peak.lat, peak.lon);
		placed.push({
			...peak,
			distance,
			bearing,
			angle,
			relief: peak.ele - eyeEle,
			compass: compassLabel(bearing),
			tier: 0,
			rank: 0,
		});
	}

	// Nearest first, so each peak is only ever tested against what stands in
	// front of it.
	placed.sort((a, b) => a.distance - b.distance);
	const visible: PlacedPeak[] = [];
	const terrain = options.terrain;
	for (const peak of placed) {
		if (terrain && hiddenByGround(terrain, peak, eyeEle)) continue;
		if (!isOccluded(peak, visible)) visible.push(peak);
	}

	// What makes a label worth showing is how much the summit dominates the
	// frame: high in the view, and near enough to read as a mountain rather
	// than a bump on the horizon.
	const limit = options.limit ?? 40;
	visible.sort((a, b) => score(b, horizon) - score(a, horizon));
	const kept = selectAcrossHorizon(visible, limit);
	// Ranked before the list is turned back into a sweep of the horizon, because
	// the ranking is the tie-break the viewer needs and bearing order is not.
	kept
		.slice()
		.sort((a, b) => score(b, horizon) - score(a, horizon))
		.forEach((peak, index) => {
			peak.rank = index;
		});
	return assignTiers(kept);
}

/**
 * Pick the labels, one sector of the compass at a time.
 *
 * Ranking alone puts every label on the highest skyline in the frame. Going
 * round the horizon first — best in each sector, then the best of what is left
 * — keeps the quiet directions named, which is where the smaller tops live.
 */
function selectAcrossHorizon(ranked: PlacedPeak[], limit: number): PlacedPeak[] {
	const kept: PlacedPeak[] = [];
	const usedSectors = new Set<number>();

	const fits = (peak: PlacedPeak) =>
		kept.every((other) => Math.abs(bearingDelta(other.bearing, peak.bearing)) >= MIN_SEPARATION);

	for (const peak of ranked) {
		if (kept.length >= limit) break;
		const sector = Math.floor(normalizeDegrees(peak.bearing) / (360 / SECTORS));
		if (usedSectors.has(sector) || !fits(peak)) continue;
		usedSectors.add(sector);
		kept.push(peak);
	}

	for (const peak of ranked) {
		if (kept.length >= limit) break;
		if (kept.includes(peak) || !fits(peak)) continue;
		kept.push(peak);
	}

	return kept.sort((a, b) => a.bearing - b.bearing);
}

/**
 * Stack neighbouring labels instead of letting them collide.
 *
 * Walking the horizon in order, a label goes in the lowest row that has nothing
 * else within `TIER_WINDOW` degrees of it. Where the peaks are genuinely dense
 * the rows run out and the tiers repeat — but by then the previous occupant of
 * that row is far enough round the compass to be off the side of the screen.
 */
function assignTiers(peaks: PlacedPeak[]): PlacedPeak[] {
	const lastInTier: number[] = new Array(TIERS).fill(Number.NEGATIVE_INFINITY);

	for (const peak of peaks) {
		let tier = 0;
		let widestGap = Number.NEGATIVE_INFINITY;
		for (let candidate = 0; candidate < TIERS; candidate += 1) {
			const gap = peak.bearing - lastInTier[candidate];
			if (gap >= TIER_WINDOW) {
				tier = candidate;
				break;
			}
			if (gap > widestGap) {
				widestGap = gap;
				tier = candidate;
			}
		}
		peak.tier = tier;
		lastInTier[tier] = peak.bearing;
	}

	return peaks;
}

/**
 * A summit's claim on one of the limited label slots.
 *
 * Height above the horizon line is what the eye reads as "a mountain", so that
 * carries the score; the elevation term is a light thumb on the scale for the
 * genuinely big ones, and the distance term breaks ties towards whatever is
 * close enough to have detail.
 */
function score(peak: PlacedPeak, horizon: number): number {
	return (peak.angle - horizon) * 2 + peak.ele / 1500 - peak.distance / 40000;
}

// Where any point on the ground or in the air sits, seen from the camera.

// The peak maths above, for one point that is not a summit: another panorama's
// drone, say. Curvature and refraction apply the same way.
export function placePoint(
	from: { lat: number; lon: number },
	to: { lat: number; lon: number; ele: number },
	eyeEle: number,
): { bearing: number; distance: number; angle: number } {
	const distance = haversine(from.lat, from.lon, to.lat, to.lon);
	return {
		bearing: initialBearing(from.lat, from.lon, to.lat, to.lon),
		distance,
		angle: apparentAngle(to.ele, eyeEle, distance),
	};
}

export function formatDistance(metres: number): string {
	return metres < 1000
		? `${Math.round(metres / 10) * 10} m`
		: `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

/**
 * Where a summit sits in the sphere's own coordinates.
 *
 * Photo Sphere Viewer measures yaw from the centre of the equirectangular
 * image, so the compass bearing of that centre — the panorama's heading — is
 * what ties the two frames together. Without it there is no honest answer, and
 * the caller should show the list rather than guess at positions.
 */
export function spherePosition(
	peak: Pick<PlacedPeak, "bearing" | "angle">,
	heading: number,
): { yaw: number; pitch: number } {
	return { yaw: bearingDelta(peak.bearing, heading) * DEG, pitch: peak.angle * DEG };
}

/**
 * One request per panorama per page, however often the viewer steps back and
 * forth. The response is marked immutable, so the browser would not go to the
 * network anyway — but it would still re-parse forty kilobytes of JSON, and the
 * promise is cached rather than the payload so two near-simultaneous callers
 * share a single flight.
 */
const inFlight = new Map<string, Promise<PeaksPayload>>();

// The ground ring, or null.

// Terrain improves the labels, but the labels never wait on it. Any failure
// returns null, from a cold Worker to a missing tile. The labels then use the
// named-summit check alone.
const terrainInFlight = new Map<string, Promise<TerrainRing | null>>();

export function fetchTerrain(id: string): Promise<TerrainRing | null> {
	const pending = terrainInFlight.get(id);
	if (pending) return pending;

	const request = fetch(`${API.terrain}/${encodeURIComponent(id)}`, {
		headers: { Accept: "application/json" },
	})
		.then((res) => (res.ok ? (res.json() as Promise<TerrainRing>) : null))
		.catch(() => null);

	// Remember a success only. A failed lookup can work on the next panorama.
	void request.then((ring) => {
		if (!ring) terrainInFlight.delete(id);
	});
	terrainInFlight.set(id, request);
	return request;
}

export async function fetchPeaks(id: string): Promise<PeaksPayload> {
	const pending = inFlight.get(id);
	if (pending) return pending;

	const request = (async () => {
		const res = await fetch(`${API.peaks}/${encodeURIComponent(id)}`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? `Could not load nearby peaks (${res.status})`);
		}
		return (await res.json()) as PeaksPayload;
	})();

	// A failure is not worth remembering: the summit database being busy for one
	// request says nothing about the next.
	request.catch(() => inFlight.delete(id));
	inFlight.set(id, request);
	return request;
}
