/**
 * Turning coordinates into a name.
 *
 * The lookup itself lives in `worker/place.js` — OSM's Nominatim asks clients to
 * identify themselves with a `User-Agent`, which a page cannot set, and the
 * Worker can cache the answer in R2 so a valley flown twenty times costs one
 * request. This module is only the client half.
 */

import { API } from "@/config";

export interface Place {
	/** What to call the spot: a summit, a hamlet, a village. Empty if nothing is named there. */
	name: string;
	/** The full Nominatim string, shown only to whoever is naming the photo. */
	display: string;
}

/**
 * Returns null rather than throwing. A name is a convenience layered on top of
 * an upload; a geocoder that is down, rate-limited, or simply has nothing to say
 * about a patch of forest must cost the title and nothing else.
 */
export async function lookupPlace(lat: number, lon: number, signal?: AbortSignal): Promise<Place | null> {
	try {
		const url = `${API.place}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
		const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<Place>;
		if (!data.name) return null;
		return { name: data.name, display: data.display ?? "" };
	} catch {
		return null;
	}
}
