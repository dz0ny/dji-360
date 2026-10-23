/**
 * Browser-side derivative generation.
 *
 * Workers have no sharp and no Cloudflare Images plan here, so the phone or
 * laptop doing the upload also does the resizing. That keeps the pipeline free
 * and means the viewer never has to pull a 40 MB original onto a phone.
 *
 * One decode, every output: the source is decoded once at archive width and
 * every smaller size is drawn down from that same bitmap. Decoding a
 * 12000×6000 panorama three times would cost ~288 MB of RGBA per pass, which
 * is exactly how a phone tab gets killed mid-upload.
 */

import { DERIVATIVES } from "@/config";
import { type CardFacts, horizonCrop, renderCard } from "@/lib/card";

export interface Derivative {
	blob: Blob;
	width: number;
	height: number;
	type: string;
}

/** Safari only grew `OffscreenCanvas.convertToBlob` in 16.4; fall back politely. */
async function encode(
	source: ImageBitmap,
	width: number,
	height: number,
	quality: number,
): Promise<{ blob: Blob; type: string }> {
	const draw = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
		ctx.drawImage(source, 0, 0, width, height);
	};

	// WebP is ~30% smaller than JPEG at the same quality and is universally
	// supported by anything that can run WebGL, which the viewer needs anyway.
	const type = "image/webp";

	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (ctx && typeof canvas.convertToBlob === "function") {
			draw(ctx);
			const blob = await canvas.convertToBlob({ type, quality });
			return { blob, type: blob.type || type };
		}
	}

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser cannot resize images (no 2D canvas)");
	draw(ctx);

	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
	if (!blob) throw new Error("Could not encode the resized image");
	return { blob, type: blob.type || type };
}

export interface Derivatives {
	/**
	 * Full-resolution WebP — the same pixels as the camera file. `null` when the
	 * browser could not decode or encode at that size, in which case the caller
	 * should store the source file untouched.
	 */
	archive: Derivative | null;
	/**
	 * 8192px — the middle rung between the boot texture and the archive. `null`
	 * when the source was smaller than that, or when the encode failed; the
	 * viewer then simply offers one rung fewer.
	 */
	large: Derivative | null;
	preview: Derivative;
	/** The branded share card — a horizon crop with the caption over it. */
	cover: Derivative;
	thumb: Derivative;
	/** Decoded source dimensions — the true capture size. */
	sourceWidth: number;
	sourceHeight: number;
}

/**
 * `onStep` reports 0–1 across the decode and the encodes that follow. Encoding 72 MP
 * takes long enough on a phone that a frozen progress bar reads as a hang.
 */
export async function buildDerivatives(
	file: File,
	facts: CardFacts = {},
	onStep?: (ratio: number) => void,
): Promise<Derivatives> {
	// Full decode, deliberately: the archive keeps every pixel, and every
	// smaller size is drawn down from this one bitmap rather than re-decoding.
	const bitmap = await createImageBitmap(file);
	onStep?.(0.3);

	try {
		const ratio = bitmap.height / bitmap.width || 0.5;

		const derive = async (width: number, quality: number, done: number): Promise<Derivative> => {
			const w = Math.min(width, bitmap.width);
			const h = Math.round(w * ratio);
			const { blob, type } = await encode(bitmap, w, h, quality);
			onStep?.(done);
			return { blob, width: w, height: h, type };
		};

		/**
		 * A 12000×6000 canvas is ~288 MB of RGBA, and a phone under memory
		 * pressure will fail the encode rather than the decode. Losing the
		 * re-encode is survivable — the source file gets stored instead — so it
		 * must not take the whole upload down with it.
		 */
		const archive = await (async () => {
			const { quality, maxSide } = DERIVATIVES.archive;
			if (bitmap.width > maxSide || bitmap.height > maxSide) return null;
			try {
				const { blob, type } = await encode(bitmap, bitmap.width, bitmap.height, quality);
				return { blob, width: bitmap.width, height: bitmap.height, type };
			} catch {
				return null;
			}
		})();
		onStep?.(0.75);

		/**
		 * Only worth making when it is meaningfully smaller than the archive —
		 * re-encoding a 8500px capture to 8192px buys nothing but a second file.
		 */
		const large = await (async () => {
			const { width, quality } = DERIVATIVES.large;
			if (bitmap.width < width * 1.15) return null;
			try {
				return await derive(width, quality, 0.82);
			} catch {
				return null;
			}
		})();

		return {
			archive,
			large,
			preview: await derive(DERIVATIVES.preview.width, DERIVATIVES.preview.quality, 0.9),
			cover: await renderCard(bitmap, horizonCrop(bitmap.width, bitmap.height), facts),
			thumb: await derive(DERIVATIVES.thumb.width, DERIVATIVES.thumb.quality, 1),
			sourceWidth: bitmap.width,
			sourceHeight: bitmap.height,
		};
	} finally {
		bitmap.close();
	}
}

/**
 * A panorama that is not 2:1 is not equirectangular, and the sphere viewer will
 * stretch it. Warn rather than block — cropped panoramas are still worth having.
 */
export function aspectWarning(
	width: number | undefined,
	height: number | undefined,
): string | null {
	if (!width || !height) return null;
	const ratio = width / height;
	if (Math.abs(ratio - 2) < 0.02) return null;
	return `This image is ${ratio.toFixed(2)}:1, not the 2:1 an equirectangular panorama needs — it will look stretched.`;
}
