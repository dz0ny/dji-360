// Where the sun stood when the shutter fired.

// The formulas are the low-precision solar position that suncalc and most
// planetarium apps use. They hold to well under a degree for any date in this
// archive. A label on a sphere needs far less than that.

// One convention differs from suncalc on purpose. Its azimuth counts from
// south, clockwise. Here the bearing counts from north, like every other
// bearing on this site, so it feeds `spherePosition` without a correction.

// The instant comes from `capturedAt`. The upload turned the EXIF wall clock
// into UTC with the time zone of the browser that did the upload. Slovenian
// flights uploaded in Slovenia land on the right instant. A flight abroad,
// uploaded at home, would be off by the difference between the two zones.

const DEG = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2_440_588;
const J2000 = 2_451_545;

/** Obliquity of the ecliptic. */
const OBLIQUITY = 23.4397 * DEG;

export interface SunPosition {
	/** Degrees clockwise from true north. */
	bearing: number;
	/** Degrees above (+) or below (−) the horizontal, with refraction. */
	elevation: number;
}

function daysSinceJ2000(date: Date): number {
	return date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
}

// The atmosphere lifts the sun near the horizon by about half a degree. That
// is the whole width of the disc, and golden hour lives exactly there.
function refraction(elevation: number): number {
	const h = Math.max(elevation, 0);
	return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
	const d = daysSinceJ2000(date);

	const meanAnomaly = (357.5291 + 0.98560028 * d) * DEG;
	const center =
		(1.9148 * Math.sin(meanAnomaly) +
			0.02 * Math.sin(2 * meanAnomaly) +
			0.0003 * Math.sin(3 * meanAnomaly)) *
		DEG;
	const eclipticLongitude = meanAnomaly + center + 102.9372 * DEG + Math.PI;

	const declination = Math.asin(Math.sin(OBLIQUITY) * Math.sin(eclipticLongitude));
	const rightAscension = Math.atan2(
		Math.sin(eclipticLongitude) * Math.cos(OBLIQUITY),
		Math.cos(eclipticLongitude),
	);

	const sidereal = (280.16 + 360.9856235 * d) * DEG + lon * DEG;
	const hourAngle = sidereal - rightAscension;
	const phi = lat * DEG;

	const altitude = Math.asin(
		Math.sin(phi) * Math.sin(declination) +
			Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle),
	);
	// From south, clockwise, as suncalc has it. Plus 180° turns it to north.
	const fromSouth = Math.atan2(
		Math.sin(hourAngle),
		Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
	);

	return {
		bearing: (((fromSouth / DEG + 180) % 360) + 360) % 360,
		elevation: (altitude + refraction(altitude)) / DEG,
	};
}

// The light the reader sees in the frame, named.

// Golden hour runs from 4° below the horizon to 6° above it, the band most
// photographers use. Blue hour is the 2° below that. Anything else is plain
// daylight or night and gets no badge.
export function lightOf(elevation: number): "Golden hour" | "Blue hour" | null {
	if (elevation >= -4 && elevation < 6) return "Golden hour";
	if (elevation >= -6 && elevation < -4) return "Blue hour";
	return null;
}
