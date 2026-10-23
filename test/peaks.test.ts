import { describe, expect, test } from "bun:test";
import { eyeElevation, groundHides, type PeaksPayload, placePeaks, type TerrainRing } from "@/lib/peaks";

const payload = (groundEle: number | null, peaks: PeaksPayload["peaks"] = []): PeaksPayload => ({
	lat: 45.7219,
	lon: 14.4684,
	radius: 60000,
	groundEle,
	peaks,
});

describe("eyeElevation", () => {
	test("adds the height above take-off to the ground (Mali vrhek)", () => {
		// The recorded sea-level figure, 548 m, sits 44 m underground.
		expect(eyeElevation(payload(592), { altitude: 96.7, altitudeAmsl: 548.432 })).toBeCloseTo(688.7, 1);
	});

	test("reads one shared field as sea level when it clears the ground (Iga vas 2025)", () => {
		expect(eyeElevation(payload(577), { altitude: 767.19, altitudeAmsl: 767.19 })).toBe(767.19);
	});

	test("falls back to the ground when one shared field sits under it (Žaga)", () => {
		expect(eyeElevation(payload(583), { altitude: 512.073, altitudeAmsl: 512.073 })).toBe(583);
	});

	test("takes a height up to DJI's 500 m cap as above take-off (Racna gora)", () => {
		expect(eyeElevation(payload(1101), { altitude: 499.8, altitudeAmsl: 1381.969 })).toBeCloseTo(1600.8, 1);
	});

	test("uses the recorded sea-level figure when there is no ground", () => {
		expect(eyeElevation(payload(null), { altitude: 96.7, altitudeAmsl: 548.432 })).toBe(548.432);
	});
});

// A ring with one hill in it: 700 m high at 450 m, due north. The rest is a
// flat plain at 590 m.
function ringWithHill(): TerrainRing {
	const distances = [150, 300, 450, 600, 900, 1500, 3000, 6000, 9000, 15000];
	const ele = Array.from({ length: 360 }, (_, bearing) =>
		distances.map((d) => (bearing <= 2 || bearing >= 358) && d === 450 ? 700 : 590),
	);
	return { bearings: 360, distances, ele };
}

describe("groundHides", () => {
	test("a hill in front hides what stands lower behind it", () => {
		// From 690 m, the hill at 450 m rises 1.3° above level.
		expect(groundHides(ringWithHill(), { bearing: 0, angle: 0.5 }, 690, 6000)).toBe(true);
	});

	test("the same direction to the side of the hill stays clear", () => {
		expect(groundHides(ringWithHill(), { bearing: 20, angle: 0.5 }, 690, 6000)).toBe(false);
	});

	test("a target nearer than the hill stays clear", () => {
		expect(groundHides(ringWithHill(), { bearing: 0, angle: 0.5 }, 690, 400)).toBe(false);
	});
});

describe("placePeaks", () => {
	// One summit due north, 7.5 km out, 862 m: Veje on Mali vrhek, in effect.
	const veje = { name: "Veje", lat: 45.7219 + 7500 / 111320, lon: 14.4684, ele: 862 };

	test("keeps a summit with clear ground in front", () => {
		const placed = placePeaks(payload(592, [veje]), { altitude: 96.7 });
		expect(placed.map((p) => p.name)).toEqual(["Veje"]);
	});

	test("drops it once a nearer hill rises above it", () => {
		const ring = ringWithHill();
		for (const column of [ring.ele[0], ring.ele[1], ring.ele[359]]) column[2] = 900;
		const placed = placePeaks(payload(592, [veje]), { altitude: 96.7, terrain: ring });
		expect(placed).toEqual([]);
	});
});
