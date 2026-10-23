import { afterEach, describe, expect, test } from "bun:test";
import { cameraName, displayTitle, fetchPhotos, type Photo, plainTitle } from "@/lib/photos";

// `fetchPhotos` against a fake API. It corrects the drone clock first and
// labels same-flight shots second, and both depend on real record shapes.

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function serve(photos: Partial<Photo>[]) {
	globalThis.fetch = (async () => new Response(JSON.stringify({ photos }))) as unknown as typeof fetch;
}

const record = (id: string, title: string, capturedAt: string, originalName: string): Partial<Photo> => ({
	id,
	title,
	capturedAt,
	originalName,
	camera: "DJI FC9313",
	lat: 45.72,
	lon: 14.47,
});

describe("fetchPhotos", () => {
	test("corrects the clock and keeps the stored value beside it", async () => {
		serve([record("a", "Mali vrhek", "2026-10-03T15:55:30.000Z", "dji_fly_20261003_115634_0474_1_pano.jpg")]);
		const [photo] = await fetchPhotos();
		expect(photo.capturedAt).toBe("2026-10-03T09:55:30.000Z");
		expect(photo.storedCapturedAt).toBe("2026-10-03T15:55:30.000Z");
	});

	test("adds the time to same-name, same-day shots only", async () => {
		serve([
			record("a", "Mali vrhek", "2026-10-03T09:55:30.000Z", "a.jpg"),
			record("b", "Mali vrhek", "2026-10-03T09:57:34.000Z", "b.jpg"),
			record("c", "Orlovica", "2026-09-06T11:50:15.000Z", "c.jpg"),
			record("d", "Orlovica", "2025-05-24T16:23:07.000Z", "d.jpg"),
		]);
		const photos = await fetchPhotos();
		const byId = Object.fromEntries(photos.map((p) => [p.id, p]));

		expect(byId.a.label).toMatch(/^Mali vrhek · /);
		expect(byId.b.label).toMatch(/^Mali vrhek · /);
		expect(byId.a.label).not.toBe(byId.b.label);
		// Different days already read apart by their dates.
		expect(byId.c.label).toBeUndefined();
		expect(byId.d.label).toBeUndefined();
	});

	test("never puts the time into the plain title", async () => {
		serve([
			record("a", "Mali vrhek", "2026-10-03T09:55:30.000Z", "a.jpg"),
			record("b", "Mali vrhek", "2026-10-03T09:57:34.000Z", "b.jpg"),
		]);
		const [photo] = await fetchPhotos();
		expect(displayTitle(photo)).not.toBe("Mali vrhek");
		expect(plainTitle(photo)).toBe("Mali vrhek");
	});
});

describe("cameraName", () => {
	test("names a known drone and passes an unknown code through", () => {
		expect(cameraName("DJI FC8482")).toBe("DJI Mini 4 Pro");
		expect(cameraName("DJI FC9313")).toBe("DJI FC9313");
		expect(cameraName("")).toBe("");
	});
});
