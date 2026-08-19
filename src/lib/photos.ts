/**
 * Shared client helpers for talking to the panorama API.
 *
 * These run in the browser only — the site is prerendered, so the gallery is
 * fetched at runtime from the Worker rather than baked into the HTML.
 */

import { API } from "@/config";

export interface Photo {
	id: string;
	title: string;
	description: string;
	capturedAt: string;
	uploadedAt: string;
	lat: number | null;
	lon: number | null;
	/** Metres above the take-off point. */
	altitude: number | null;
	/** Metres above sea level, when the camera recorded it. */
	altitudeAmsl: number | null;
	/**
	 * Compass bearing of the centre of the frame. Null until the camera supplies
	 * it or someone aligns the sphere by hand — the peak labels stay off until
	 * then, because a guessed heading labels the wrong mountain.
	 */
	heading: number | null;
	width: number | null;
	height: number | null;
	/** Bytes of the stored full-size image. */
	bytes: number | null;
	/** Bytes of the camera file it was made from, when the two differ. */
	sourceBytes: number | null;
	camera: string;
	originalName: string;
	/** Whole 2:1 sphere, squashed — only useful as a backdrop. */
	thumb: string;
	/** 1200×630 horizon crop that reads as a photograph. Absent on older uploads. */
	cover: string;
	preview: string;
	/** 8192px middle rung. Null when the capture was too small to warrant one. */
	large: string | null;
	largeBytes: number | null;
	original: string;
}

export async function fetchPhotos(): Promise<Photo[]> {
	const res = await fetch(API.photos, { headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`Could not load the archive (${res.status})`);
	const data = (await res.json()) as { photos?: Photo[] };
	return data.photos ?? [];
}

/** Prefer the moment the shutter fired; fall back to when it landed in R2. */
export function photoDate(photo: Photo): Date | null {
	const raw = photo.capturedAt || photo.uploadedAt;
	if (!raw) return null;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(photo: Photo): string {
	const date = photoDate(photo);
	if (!date) return "Undated";
	return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatCoords(photo: Photo): string {
	if (photo.lat == null || photo.lon == null) return "";
	const ns = photo.lat >= 0 ? "N" : "S";
	const ew = photo.lon >= 0 ? "E" : "W";
	return `${Math.abs(photo.lat).toFixed(4)}°${ns} ${Math.abs(photo.lon).toFixed(4)}°${ew}`;
}

export function mapUrl(photo: Photo): string | null {
	if (photo.lat == null || photo.lon == null) return null;
	return `https://www.openstreetmap.org/?mlat=${photo.lat}&mlon=${photo.lon}#map=14/${photo.lat}/${photo.lon}`;
}

export function formatBytes(bytes: number | null): string {
	if (!bytes) return "";
	const mb = bytes / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;
}

/** Title falls back to the date so a card is never blank. */
export function displayTitle(photo: Photo): string {
	return photo.title || formatDate(photo);
}

/** Text going into `innerHTML` templates — titles are user-supplied. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * The canonical, shareable address of one panorama.
 *
 * Served by `worker/pano.js`, which reuses the prerendered `/view/` shell but
 * rewrites the head with this photo's title and cover — a query string on a
 * static page cannot carry a link preview.
 */
export function viewUrl(id: string): string {
	return `/p/${encodeURIComponent(id)}/`;
}
