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

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

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
}

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

/**
 * Camera height above sea level.
 *
 * Preference order matters: a recorded AMSL figure beats anything derived. The
 * fallback adds the drone's height over its take-off point to the ground under
 * the panorama, which assumes it took off nearby — true of essentially every
 * flight, and wrong by only the few metres that assumption costs.
 */
export function eyeElevation(payload: PeaksPayload, options: ViewpointOptions): number | null {
	if (options.altitudeAmsl != null && Number.isFinite(options.altitudeAmsl)) return options.altitudeAmsl;

	if (options.altitude != null && Number.isFinite(options.altitude)) {
		// Older records kept a single `altitude` field that was whichever datum
		// the file happened to carry. No drone flies 600 m above where it took
		// off, so a figure that large is a sea-level reading wearing the wrong
		// name — and adding the ground to it would put the camera a kilometre
		// too high, tipping every label below the summit it belongs to.
		if (options.altitude > 600) return options.altitude;
		if (payload.groundEle != null) return payload.groundEle + options.altitude;
	}

	return payload.groundEle;
}

/**
 * Apparent angle to a point, in degrees, with curvature and refraction folded in.
 */
function apparentAngle(targetEle: number, eyeEle: number, distance: number): number {
	const drop = (distance * distance) / (2 * R_EFF);
	return Math.atan2(targetEle - eyeEle - drop, distance) / DEG;
}

/** How far below horizontal the true horizon sits, for a camera this high. */
function horizonAngle(eyeEle: number): number {
	return -Math.sqrt((2 * Math.max(eyeEle, 1)) / R_EFF) / DEG;
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
		// Below the horizon line is beyond it: the earth itself is in the way.
		if (angle < horizon) continue;

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
	for (const peak of placed) {
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
	kept.slice().sort((a, b) => score(b, horizon) - score(a, horizon)).forEach((peak, index) => {
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

export function formatDistance(metres: number): string {
	return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

/**
 * Where a summit sits in the sphere's own coordinates.
 *
 * Photo Sphere Viewer measures yaw from the centre of the equirectangular
 * image, so the compass bearing of that centre — the panorama's heading — is
 * what ties the two frames together. Without it there is no honest answer, and
 * the caller should show the list rather than guess at positions.
 */
export function spherePosition(peak: PlacedPeak, heading: number): { yaw: number; pitch: number } {
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

export async function fetchPeaks(id: string): Promise<PeaksPayload> {
	const pending = inFlight.get(id);
	if (pending) return pending;

	const request = (async () => {
		const res = await fetch(`${API.peaks}/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
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
