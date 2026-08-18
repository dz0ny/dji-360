/**
 * A static map image, stitched in the browser.
 *
 * Photo Sphere Viewer's map plugin wants a plain image plus the pixel position
 * of the camera inside it — it has no notion of latitude. Every hosted static
 * map API that would hand us such an image wants an API key, and a key cannot
 * live in `src/` on a static build without being public. So we fetch the OSM
 * raster tiles the browser can already request and paint them onto a canvas.
 *
 * That keeps the whole thing free and key-less, at the cost of one tile grid
 * per view (nine 256px PNGs, all CDN-cached). Attribution is drawn into the
 * image itself because the plugin has nowhere else to put it.
 */

/** Zoom 15 shows a village and its valley — the scale an aerial pano covers. */
const ZOOM = 15;
/** 3×3 tiles = 768px square, enough to pan around the pin inside the plugin. */
const GRID = 3;
const TILE = 256;

const TILE_URL = (z: number, x: number, y: number) =>
	`https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

export interface StaticMap {
	/** Object URL of the composed image. Revoke when the viewer goes away. */
	url: string;
	/** Where the panorama sits inside that image, in pixels. */
	center: { x: number; y: number };
}

/** Slippy-map projection: lon/lat → fractional tile coordinates at `zoom`. */
function project(lat: number, lon: number, zoom: number) {
	const n = 2 ** zoom;
	const rad = (lat * Math.PI) / 180;
	return {
		x: ((lon + 180) / 360) * n,
		y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
	};
}

function loadTile(url: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const img = new Image();
		// The canvas is read back via toBlob, so a tainted tile would throw.
		// OSM sends `Access-Control-Allow-Origin: *`.
		img.crossOrigin = "anonymous";
		img.onload = () => resolve(img);
		// A missing tile is a hole in the map, not a failure — keep the rest.
		img.onerror = () => resolve(null);
		img.src = url;
	});
}

/**
 * Returns null rather than throwing: the map is a nicety layered onto the
 * viewer, and a captive-portal wifi or a blocked tile host should cost the
 * minimap, not the panorama.
 */
export async function buildStaticMap(lat: number, lon: number): Promise<StaticMap | null> {
	const canvas = document.createElement("canvas");
	canvas.width = GRID * TILE;
	canvas.height = GRID * TILE;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	const point = project(lat, lon, ZOOM);
	const centreTileX = Math.floor(point.x);
	const centreTileY = Math.floor(point.y);
	const half = Math.floor(GRID / 2);
	const max = 2 ** ZOOM;

	const cells: Array<{ img: HTMLImageElement | null; col: number; row: number }> = await Promise.all(
		Array.from({ length: GRID * GRID }, (_, i) => {
			const col = i % GRID;
			const row = Math.floor(i / GRID);
			// Wrap east–west at the antimeridian; clamp north–south, where there
			// is no tile to wrap to.
			const x = (((centreTileX + col - half) % max) + max) % max;
			const y = centreTileY + row - half;
			if (y < 0 || y >= max) return Promise.resolve({ img: null, col, row });
			return loadTile(TILE_URL(ZOOM, x, y)).then((img) => ({ img, col, row }));
		}),
	);

	if (cells.every((cell) => !cell.img)) return null;

	ctx.fillStyle = "#0b1015";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	for (const { img, col, row } of cells) {
		if (img) ctx.drawImage(img, col * TILE, row * TILE);
	}

	// OSM's tile policy requires visible attribution, and the plugin renders the
	// image alone — so it has to be part of the pixels.
	const label = "© OpenStreetMap";
	ctx.font = "500 13px ui-monospace, monospace";
	const width = ctx.measureText(label).width + 12;
	ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
	ctx.fillRect(canvas.width - width, canvas.height - 20, width, 20);
	ctx.fillStyle = "#2b2b2b";
	ctx.fillText(label, canvas.width - width + 6, canvas.height - 6);

	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
	if (!blob) return null;

	return {
		url: URL.createObjectURL(blob),
		center: {
			// Offset of the true position within its own tile, plus the tiles
			// drawn to its west/north.
			x: (point.x - centreTileX + half) * TILE,
			y: (point.y - centreTileY + half) * TILE,
		},
	};
}
