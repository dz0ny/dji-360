/**
 * Upload pipeline.
 *
 * Three PUTs per panorama, deliberately ordered preview → original → thumb.
 * The thumb carries the metadata and is what `list()` enumerates, so writing it
 * last gives commit-last semantics: a run that dies halfway leaves unreferenced
 * bytes in the bucket rather than a broken card in the gallery.
 *
 * "Original" is the full-resolution WebP built in `derive.ts`, not the camera
 * file: same 12000×6000 pixels, so zooming loses nothing, at roughly a third of
 * the JPEG's bytes. The camera file is sent verbatim when the browser could not
 * re-encode it, or when the re-encode came out no smaller.
 */

import { API } from "@/config";
import { buildDerivatives } from "@/lib/derive";
import { readPanoMetadata } from "@/lib/exif";

export type UploadStage = "reading" | "resizing" | "preview" | "original" | "thumb" | "done";

export interface UploadProgress {
	stage: UploadStage;
	/** 0–1 across the whole panorama, weighted by how long each stage really takes. */
	ratio: number;
}

/**
 * Stage weights. Re-encoding at full resolution moved real cost onto the CPU —
 * a 72 MP WebP encode is now comparable to the upload it saves.
 */
const STAGE_WEIGHT: Record<Exclude<UploadStage, "done">, number> = {
	reading: 0.03,
	resizing: 0.42,
	preview: 0.1,
	original: 0.4,
	thumb: 0.05,
};

const STAGE_ORDER: Array<Exclude<UploadStage, "done">> = ["reading", "resizing", "preview", "original", "thumb"];

function overallRatio(stage: Exclude<UploadStage, "done">, within: number): number {
	let done = 0;
	for (const s of STAGE_ORDER) {
		if (s === stage) break;
		done += STAGE_WEIGHT[s];
	}
	return Math.min(1, done + STAGE_WEIGHT[stage] * within);
}

/** IDs sort chronologically, which is what the Worker's reverse sort relies on. */
export function makeId(capturedAt?: string): string {
	const date = capturedAt ? new Date(capturedAt) : new Date();
	const stamp = (Number.isNaN(date.getTime()) ? new Date() : date)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "")
		.toLowerCase();
	const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	return `${stamp}-${random}`;
}

function toBase64Url(value: object): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** XHR rather than fetch: only XHR reports upload progress. */
function put(
	url: string,
	body: Blob,
	headers: Record<string, string>,
	onProgress: (ratio: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.withCredentials = true; // carries the CF_Authorization cookie
		for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);

		xhr.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) onProgress(event.loaded / event.total);
		});

		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				onProgress(1);
				resolve();
				return;
			}
			let message = `Upload failed (${xhr.status})`;
			try {
				const parsed = JSON.parse(xhr.responseText);
				if (parsed?.error) message = parsed.error;
			} catch {
				// keep the status-code message
			}
			reject(new Error(message));
		});

		xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
		xhr.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")));

		signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(body);
	});
}

export interface UploadResult {
	id: string;
	warning: string | null;
}

export async function uploadPanorama(
	file: File,
	options: { title?: string; onProgress?: (progress: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<UploadResult> {
	const { title = "", onProgress, signal } = options;
	const report = (stage: Exclude<UploadStage, "done">, within: number) =>
		onProgress?.({ stage, ratio: overallRatio(stage, within) });

	report("reading", 0);
	const meta = await readPanoMetadata(file);
	report("reading", 1);

	report("resizing", 0);
	const { archive, preview, cover, thumb, sourceWidth, sourceHeight } = await buildDerivatives(file, (ratio) =>
		report("resizing", ratio),
	);

	// Re-encoding only earns its keep if it actually saves bytes. An already-
	// efficient source, or one the browser could not re-encode, ships as-is.
	const original = archive && archive.blob.size < file.size * 0.9 ? archive.blob : file;

	// Resolution is unchanged either way, so EXIF stays authoritative.
	const width = meta.width ?? sourceWidth;
	const height = meta.height ?? sourceHeight;
	const id = makeId(meta.capturedAt);

	const upload = (kind: string, blob: Blob, headers: Record<string, string>, onRatio: (ratio: number) => void) =>
		put(
			`${API.upload}/${id}/${kind}`,
			blob,
			{ "Content-Type": blob.type || "application/octet-stream", ...headers },
			onRatio,
			signal,
		);

	// The card is ~100 kB against the preview's ~1 MB, so the two share one
	// stage rather than making the bar rewind for a rounding error of a file.
	await upload("cover", cover.blob, {}, (r) => report("preview", r * 0.1));
	await upload("preview", preview.blob, {}, (r) => report("preview", 0.1 + r * 0.9));
	await upload("original", original, {}, (r) => report("original", r));

	// Written last: this object IS the gallery record.
	await upload(
		"thumb",
		thumb.blob,
		{
			"X-Photo-Meta": toBase64Url({
				title: title.trim(),
				capturedAt: meta.capturedAt ?? "",
				lat: meta.lat ?? "",
				lon: meta.lon ?? "",
				altitude: meta.altitude ?? "",
				camera: meta.camera ?? "",
				originalName: file.name,
				// What the archive actually holds — this is the figure the caption
				// shows and the byte count the "Original" button really costs.
				bytes: original.size,
				sourceBytes: file.size,
				width,
				height,
			}),
		},
		(r) => report("thumb", r),
	);

	onProgress?.({ stage: "done", ratio: 1 });

	const ratio = width && height ? width / height : 0;
	return {
		id,
		warning:
			ratio && Math.abs(ratio - 2) > 0.02
				? `${file.name} is ${ratio.toFixed(2)}:1, not the 2:1 an equirectangular panorama needs — it may look stretched.`
				: null,
	};
}

export async function deletePanorama(id: string): Promise<void> {
	const res = await fetch(`${API.photos}/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.error ?? `Delete failed (${res.status})`);
	}
}

export async function renamePanorama(id: string, title: string): Promise<void> {
	const res = await fetch(`${API.photos}/${encodeURIComponent(id)}`, {
		method: "PATCH",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.error ?? `Rename failed (${res.status})`);
	}
}

export async function whoami(): Promise<{ authorized: boolean; email?: string; reason?: string }> {
	const res = await fetch(API.whoami, { credentials: "include" });
	// A 404 means the Worker never saw the request — a routing problem, not an
	// auth one, so don't report it as "signed out".
	if (res.status === 404) return { authorized: false, reason: "The archive API is not responding" };
	if (!res.ok) return { authorized: false, reason: `Auth check failed (${res.status})` };
	return res.json();
}
