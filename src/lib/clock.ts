// The drone's clock, checked against the phone's.

// DJI Fly names each file after the phone's local time, as in
// `dji_fly_20261003_115634_…`. The EXIF capture time comes from the drone.
// The newer drone (FC9313) keeps its clock on China time, UTC+8, and the
// upload read that as Slovenian time. Eleven panoramas from 2026 sat exactly
// six hours late: Mali vrhek at 17:55 when the phone said 11:56.

// The correction removes the whole hours between the two clocks. The drone
// keeps the minutes and seconds, which are exact. The phone saves the file a
// minute or two after the shutter. So a gap under half an hour counts as none.
// A record that already agrees comes back unchanged.

const DJI_FLY_NAME = /^dji_fly_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/i;
const HOUR = 3_600_000;

/** Year, month, day, hour, minute, second, as the phone's clock read. */
export type WallClock = [number, number, number, number, number, number];

export function fileWallClock(fileName: string): WallClock | null {
	const match = fileName.match(DJI_FLY_NAME);
	return match ? (match.slice(1, 7).map(Number) as WallClock) : null;
}

// Move `capturedAt` by the whole hours between the drone and the phone.

// `toInstant` turns the phone's wall clock into an instant. It must use the
// zone that turned the EXIF wall clock into `capturedAt`. The two then differ
// by the clock error alone, and not by a zone.
export function correctCapture(
	capturedAt: string | undefined,
	fileName: string,
	toInstant: (wall: WallClock) => number,
): string | undefined {
	if (!capturedAt) return capturedAt;
	const stored = new Date(capturedAt).getTime();
	const wall = fileWallClock(fileName);
	if (!wall || Number.isNaN(stored)) return capturedAt;

	const hours = Math.round((stored - toInstant(wall)) / HOUR);
	// Clocks never sit further apart than the widest pair of time zones.
	if (hours === 0 || Math.abs(hours) > 26) return capturedAt;
	return new Date(stored - hours * HOUR).toISOString();
}

/** The wall clock as an instant in the browser's own zone, which is what the upload uses. */
export function localInstant(wall: WallClock): number {
	return new Date(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]).getTime();
}

// The wall clock as an instant in a named zone.

// Intl gives the zone's offset at a moment. The first guess treats the wall
// clock as UTC, and one pass corrects it. A second pass settles the hour at a
// change of summer time.
export function zonedInstant(wall: WallClock, timeZone: string): number {
	const asUtc = Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4], wall[5]);
	const offsetAt = (instant: number) => {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		}).formatToParts(new Date(instant));
		const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
		return (
			Date.UTC(
				get("year"),
				get("month") - 1,
				get("day"),
				get("hour"),
				get("minute"),
				get("second"),
			) - instant
		);
	};
	const first = asUtc - offsetAt(asUtc);
	return asUtc - offsetAt(first);
}
