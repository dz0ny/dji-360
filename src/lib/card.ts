// The branded link-preview card.

// `deriveCover` gave scrapers a bare horizon crop. The crop is a photograph,
// but it names neither the place nor the archive. A feed shows this card 400px
// wide, beside a dozen others. So the card carries its own caption: the place,
// the date, and the wordmark.

// A 2D canvas draws it. The browser already cuts the crop, in `derive.ts`, and
// already holds the fonts of the site. The Worker touches no pixel, by design.
// A Satori and resvg pipeline would need megabytes of wasm at the edge.

import { CARD, SITE_NAME, SITE_TAGLINE } from "@/config";

/** What the caption can say. Every field is optional, and the card adapts. */
export interface CardFacts {
	title?: string;
	capturedAt?: string | null;
	lat?: number | null;
	lon?: number | null;
	camera?: string | null;
}

/** The source rectangle to draw from: the horizon slice. */
export interface CardCrop {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

// `worker/pano.js` formats the same strings for the `<head>`. This file repeats
// them. The worker runs as plain JS, with no build step and no `@/` resolution.
// `src/lib/place.ts` and `worker/place.js` set the precedent.

export function formatDate(raw?: string | null): string {
	if (!raw) return "";
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

export function formatCoords(lat?: number | null, lon?: number | null): string {
	if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return "";
	return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
}

/** The second line of the caption: the facts this panorama has. */
export function factsLine(facts: CardFacts): string {
	return [formatDate(facts.capturedAt), formatCoords(facts.lat, facts.lon), facts.camera || ""]
		.filter(Boolean)
		.join("  ·  ");
}

/** An untitled panorama still has a date, and a date beats an empty caption. */
export function cardTitle(facts: CardFacts): string {
	return (facts.title || "").trim() || formatDate(facts.capturedAt) || "Panorama";
}

// Resolve a font family through its CSS variable. The Fonts API of Astro names
// each family itself, so `--font-fraunces` holds the real family name. The
// fallback stack keeps the card readable, because a system serif reads fine.
function fontStack(variable: string, fallback: string): string {
	if (typeof document === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
	return value ? `${value}, ${fallback}` : fallback;
}

// Load the faces before `fillText` runs. Canvas draws with the faces it has,
// and it never waits. The page preloads only the body face. Without this call,
// the first card of a session comes out in Georgia. A failure stops nothing,
// because the fallback face draws instead.
async function ensureFonts(specs: string[]): Promise<void> {
	if (typeof document === "undefined" || !document.fonts) return;
	await Promise.all(
		specs.map((spec) =>
			document.fonts.load(spec).catch(() => {
				// the fallback face draws instead
			}),
		),
	);
}

/** Chrome 99 and Safari 17 added `ctx.letterSpacing`, so tracking stays optional. */
function setTracking(ctx: CanvasRenderingContext2D, value: string): void {
	if ("letterSpacing" in ctx)
		(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value;
}

/** Wrap greedily, clamp to `maxLines`, and put an ellipsis on the last one. */
function wrap(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
	maxLines: number,
): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (!words.length) return [];

	const lines: string[] = [];
	let line = words[0];
	let dropped = false;

	for (const word of words.slice(1)) {
		const candidate = `${line} ${word}`;
		if (ctx.measureText(candidate).width <= maxWidth) {
			line = candidate;
			continue;
		}
		lines.push(line);
		line = word;
		if (lines.length === maxLines) {
			dropped = true;
			break;
		}
	}
	if (lines.length < maxLines) lines.push(line);

	// Mark the cut when words fall off the end, and when one word is wider than
	// the frame. A greedy line never overflows by itself. So without the flag,
	// a third line of a name goes missing and nothing says so.
	const last = lines.length - 1;
	if (dropped || ctx.measureText(lines[last]).width > maxWidth) {
		let cut = lines[last];
		while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
		lines[last] = `${cut}…`;
	}
	return lines;
}

// Compose the card. The crop runs full-bleed, a scrim climbs the bottom edge,
// and the caption sits over it. Full-bleed, by choice: a side panel of text
// costs half the frame. The reader shares the photograph, so the caption only
// has to stay legible.
export function drawCard(
	canvas: HTMLCanvasElement,
	source: CanvasImageSource,
	crop: CardCrop,
	facts: CardFacts,
): void {
	const { width: W, height: H } = CARD;
	canvas.width = W;
	canvas.height = H;

	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser cannot draw the share card (no 2D canvas)");

	ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);

	// The scrim takes three stops, not two. A straight ramp reads as a grey
	// wash. An eased one reads as shade.
	const scrim = ctx.createLinearGradient(0, H * 0.38, 0, H);
	scrim.addColorStop(0, "rgba(7, 13, 18, 0)");
	scrim.addColorStop(0.55, "rgba(7, 13, 18, 0.46)");
	scrim.addColorStop(1, "rgba(7, 13, 18, 0.88)");
	ctx.fillStyle = scrim;
	ctx.fillRect(0, H * 0.38, W, H * 0.62);

	// A matching wash holds the wordmark against a bright sky. It leaves the
	// rest of the frame alone.
	const top = ctx.createLinearGradient(0, 0, 0, H * 0.26);
	top.addColorStop(0, "rgba(7, 13, 18, 0.5)");
	top.addColorStop(1, "rgba(7, 13, 18, 0)");
	ctx.fillStyle = top;
	ctx.fillRect(0, 0, W, H * 0.26);

	const display = fontStack("--font-fraunces", "Georgia, serif");
	const body = fontStack("--font-public", "system-ui, sans-serif");

	const PAD = 64;
	ctx.textBaseline = "alphabetic";

	/* the wordmark */

	ctx.save();
	ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
	ctx.shadowBlur = 12;

	ctx.fillStyle = CARD.accent;
	ctx.fillRect(PAD, 56, 34, 3);

	ctx.font = `600 23px ${body}`;
	setTracking(ctx, "0.14em");
	ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
	ctx.fillText(SITE_NAME.toUpperCase(), PAD + 50, 65);

	// The tagline joins the line only when the wordmark leaves room.
	const markWidth = ctx.measureText(SITE_NAME.toUpperCase()).width;
	ctx.font = `500 17px ${body}`;
	setTracking(ctx, "0.18em");
	ctx.fillStyle = "rgba(255, 255, 255, 0.62)";
	if (PAD + 50 + markWidth + 24 + ctx.measureText(SITE_TAGLINE.toUpperCase()).width < W - PAD) {
		ctx.fillText(SITE_TAGLINE.toUpperCase(), PAD + 50 + markWidth + 24, 64);
	}
	ctx.restore();

	/* the caption */

	ctx.save();
	ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
	ctx.shadowBlur = 18;

	// The bottom row stays reserved, with or without a caption. The badge sits
	// on that row, and a wide title on an undated panorama would run into it.
	// The 54px also clears the descenders of a two-line name at 54px.
	const caption = factsLine(facts);
	const baseline = H - PAD - 54;

	// One line at 62px where the title fits, two at 54px where it does not.
	// Two lines keep more of the name than one line in a smaller face.
	setTracking(ctx, "-0.01em");
	const title = cardTitle(facts);
	const measure = (px: number) => {
		ctx.font = `700 ${px}px ${display}`;
		return wrap(ctx, title, W - PAD * 2, 2);
	};

	let size = 62;
	let lines = measure(size);
	if (lines.length > 1) {
		size = 54;
		lines = measure(size);
	}

	const lineHeight = Math.round(size * 1.14);
	ctx.fillStyle = "#ffffff";
	lines.forEach((line, index) => {
		ctx.fillText(line, PAD, baseline - (lines.length - 1 - index) * lineHeight);
	});

	// The accent rule sits above the title, as it does on the headings of the site.
	const ruleY = baseline - (lines.length - 1) * lineHeight - size - 26;
	ctx.fillStyle = CARD.accent;
	ctx.fillRect(PAD, ruleY, 56, 3);

	if (caption) {
		ctx.font = `500 22px ${body}`;
		setTracking(ctx, "0.04em");
		ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
		ctx.fillText(caption, PAD, H - PAD + 4);
	}

	// The badge names what a click gives. A still frame cannot show the drag.
	ctx.font = `600 17px ${body}`;
	setTracking(ctx, "0.2em");
	ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
	ctx.textAlign = "right";
	ctx.fillText("360° PANORAMA", W - PAD, H - PAD + 4);
	ctx.restore();
}

/** `convertToBlob` belongs to OffscreenCanvas, and a DOM canvas takes a callback. */
function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the share card"))),
			type,
			quality,
		);
	});
}

// Draw the card and encode it as JPEG, not as the WebP of the other
// derivatives. X, LinkedIn and most feed scrapers refuse a WebP `og:image`.
// They show a bare link instead, which is the problem this card solves.
export async function renderCard(
	source: CanvasImageSource,
	crop: CardCrop,
	facts: CardFacts,
): Promise<{ blob: Blob; width: number; height: number; type: string }> {
	const display = fontStack("--font-fraunces", "Georgia, serif");
	const body = fontStack("--font-public", "system-ui, sans-serif");
	await ensureFonts([`700 62px ${display}`, `600 23px ${body}`, `500 22px ${body}`]);

	const canvas = document.createElement("canvas");
	drawCard(canvas, source, crop, facts);

	const blob = await toBlob(canvas, CARD.type, CARD.quality);
	return { blob, width: CARD.width, height: CARD.height, type: blob.type || CARD.type };
}

// The horizon slice. An equirectangular projection maps degrees to pixels
// linearly. So a slice `fovDegrees / 360` wide, centred on the frame, is the
// view the sphere opens at. Photo Sphere Viewer puts yaw 0 and pitch 0 at the
// centre. The same degrees per pixel vertically keeps the crop undistorted.
export function horizonCrop(width: number, height: number): CardCrop {
	const sw = Math.min(width, Math.round((width * CARD.fovDegrees) / 360));
	const sh = Math.min(height, Math.round(sw / (CARD.width / CARD.height)));
	return { sx: Math.round((width - sw) / 2), sy: Math.round((height - sh) / 2), sw, sh };
}
