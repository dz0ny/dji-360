/**
 * Build-time constants.
 *
 * The site builds with `output: "static"`, so `import.meta.env` is empty at
 * runtime — anything the prerendered pages need has to live here as a plain
 * constant. Secrets never belong in this file; those go in `worker/`.
 */

export const SITE_NAME = "dji.dz0ny.dev";
export const SITE_TAGLINE = "360° archive";
export const SITE_DESCRIPTION =
	"A personal archive of 360° aerial panoramas shot on DJI drones. Drag, pinch, or tilt your phone to look around.";
export const SITE_URL = "https://dji.dz0ny.dev";

/**
 * Default link-preview card, 1200×630. Lives in `public/` because scrapers need
 * a stable URL and never run the hashing that `astro:assets` applies.
 * Regenerate with `bun run og`.
 */
export const SOCIAL_IMAGE = "/og.jpg";

/**
 * Worker endpoints.
 *
 * `run_worker_first = ["/~*"]` in `wrangler.toml` hands every `/~/*` path to
 * `worker/index.js`; everything else is served from the built assets. That rule
 * is the same one wrangler applies locally, so these paths resolve identically
 * in development and in production.
 */
export const API = {
	photos: "/~/api/photos",
	whoami: "/~/api/whoami",
	/** `/~/api/peaks/<id>` — named summits around one panorama, cached in R2. */
	peaks: "/~/api/peaks",
	/** `/~/api/upload/<id>/<thumb|cover|preview|large|original>/` */
	upload: "/~/api/upload",
	img: "/~/img",
} as const;

/**
 * Client-side derivative sizes. A stitched DJI panorama is 12000×6000 and
 * 30–50 MB of JPEG; the browser produces every size before anything leaves the
 * device, so the Worker never touches a pixel.
 *
 * One decode feeds all of them — the full-resolution bitmap is drawn down for
 * each smaller size rather than decoding the source again.
 */
export const DERIVATIVES = {
	/**
	 * The archive copy. Full capture resolution, re-encoded JPEG → WebP: same
	 * pixels, roughly a third of the bytes, so zooming still resolves detail.
	 * WebP tops out at 16383px per side, which no equirectangular hits.
	 */
	archive: { quality: 0.9, maxSide: 16383 },
	/** Sphere texture. 4096×2048 = 8.4 MP, inside iOS Safari's canvas ceiling. */
	preview: { width: 4096, quality: 0.82 },
	/**
	 * The middle rung of the quality ladder. 4096 is what a phone can boot with;
	 * the archive copy is the whole 12000px capture and tens of megabytes. 8192
	 * sits between them — sharp enough that zooming resolves real detail, small
	 * enough to pull over a phone connection — and every desktop GPU made in the
	 * last decade takes an 8192px texture without complaint.
	 */
	large: { width: 8192, quality: 0.82 },
	/**
	 * Social card. Cropped to a slice of the horizon rather than the whole
	 * sphere — a full equirectangular squashed into a link preview is unreadable.
	 * 1200×630 is the size every scraper wants; 110° is a natural-looking FOV.
	 */
	cover: { width: 1200, height: 630, fovDegrees: 110, quality: 0.8 },
	/** Gallery card. 2:1 like everything else. */
	thumb: { width: 800, quality: 0.72 },
} as const;
