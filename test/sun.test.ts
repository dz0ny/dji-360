import { describe, expect, test } from "bun:test";
import { lightOf, sunPosition } from "@/lib/sun";

// Mali vrhek, the panorama the checks below sit on.
const LAT = 45.7219;
const LON = 14.4684;

describe("sunPosition", () => {
	test("stands due south at solar noon", () => {
		const { bearing } = sunPosition(new Date("2026-10-03T10:55:00Z"), LAT, LON);
		expect(bearing).toBeGreaterThan(178);
		expect(bearing).toBeLessThan(184);
	});

	test("reaches 90° − latitude + 23.44° at the June solstice", () => {
		const { elevation } = sunPosition(new Date("2026-06-21T10:50:00Z"), LAT, LON);
		expect(elevation).toBeCloseTo(90 - LAT + 23.44, 0);
	});

	test("sits on the horizon at sunset, around 18:40 local in early October", () => {
		const { bearing, elevation } = sunPosition(new Date("2026-10-03T16:40:00Z"), LAT, LON);
		expect(Math.abs(elevation)).toBeLessThan(1);
		// West-south-west, counted from north. A bearing near 85° would mean the
		// suncalc convention (from south) leaked through.
		expect(bearing).toBeGreaterThan(255);
		expect(bearing).toBeLessThan(275);
	});

	test("puts the Grohari sunset where the photo shows it", () => {
		// 18 Aug 2026, 19:33 local, after the drone clock correction.
		const { bearing, elevation } = sunPosition(new Date("2026-08-18T17:33:22Z"), 45.6175, 14.5935);
		expect(bearing).toBeCloseTo(284, 0);
		expect(elevation).toBeCloseTo(4.8, 0);
	});
});

describe("lightOf", () => {
	test("names the bands", () => {
		expect(lightOf(5)).toBe("Golden hour");
		expect(lightOf(-3.9)).toBe("Golden hour");
		expect(lightOf(-5)).toBe("Blue hour");
		expect(lightOf(30)).toBeNull();
		expect(lightOf(-10)).toBeNull();
	});
});
