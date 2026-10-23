import { describe, expect, test } from "bun:test";
import { correctCapture, fileWallClock, zonedInstant } from "@/lib/clock";

// The records below are real, from the archive as it stood in October 2026.

const ljubljana = (wall: Parameters<typeof zonedInstant>[0]) => zonedInstant(wall, "Europe/Ljubljana");

describe("fileWallClock", () => {
	test("reads the phone's time from a DJI Fly name", () => {
		expect(fileWallClock("dji_fly_20261003_115634_0474_1791101810701_pano.jpg")).toEqual([2026, 10, 3, 11, 56, 34]);
	});

	test("ignores any other name", () => {
		expect(fileWallClock("IMG_0001.JPG")).toBeNull();
	});
});

describe("zonedInstant", () => {
	test("summer time is two hours ahead of UTC", () => {
		expect(new Date(ljubljana([2026, 10, 3, 11, 56, 34])).toISOString()).toBe("2026-10-03T09:56:34.000Z");
	});

	test("winter time is one hour ahead of UTC", () => {
		expect(new Date(ljubljana([2024, 10, 30, 12, 53, 36])).toISOString()).toBe("2024-10-30T11:53:36.000Z");
	});
});

describe("correctCapture", () => {
	test("pulls a China-time drone clock back by six hours (Mali vrhek, FC9313)", () => {
		const fixed = correctCapture(
			"2026-10-03T15:55:30.000Z",
			"dji_fly_20261003_115634_0474_1791101810701_pano.jpg",
			ljubljana,
		);
		expect(fixed).toBe("2026-10-03T09:55:30.000Z");
	});

	test("moves a late evening flight back to its own day (Grohari, FC9313)", () => {
		const fixed = correctCapture(
			"2026-08-18T23:33:22.000Z",
			"dji_fly_20260818_193426_0295_1787075130565_pano.jpg",
			ljubljana,
		);
		expect(fixed).toBe("2026-08-18T17:33:22.000Z");
	});

	test("leaves a correct record alone (Grohari 2024, FC8482)", () => {
		const stored = "2024-09-22T15:24:04.000Z";
		expect(correctCapture(stored, "dji_fly_20240922_172528_0446_1727022177478_pano.jpg", ljubljana)).toBe(stored);
	});

	test("leaves the one synced FC9313 flight alone (Žaga)", () => {
		const stored = "2026-10-14T10:31:28.000Z";
		expect(correctCapture(stored, "dji_fly_20261014_123128_0496_1791974093837_pano.JPG", ljubljana)).toBe(stored);
	});

	test("does nothing without a DJI Fly name or a time", () => {
		expect(correctCapture("2026-10-03T15:55:30.000Z", "pano.jpg", ljubljana)).toBe("2026-10-03T15:55:30.000Z");
		expect(correctCapture(undefined, "dji_fly_20261003_115634_0474_1_pano.jpg", ljubljana)).toBeUndefined();
	});
});
