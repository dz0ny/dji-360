/**
 * Minimal client-side JPEG metadata reader.
 *
 * Only the fields the archive actually shows are parsed — capture time, GPS,
 * altitude, camera — so there is no need for a 100 kB EXIF library on a page
 * that already ships three.js. Reads the first 256 kB of the file, which
 * comfortably covers the APP1 segments on every DJI panorama.
 *
 * Anything unparseable simply comes back undefined; upload never depends on it.
 */

export interface PanoMetadata {
	capturedAt?: string;
	lat?: number;
	lon?: number;
	/** Height above the take-off point, in metres — what a drone shot actually means by "altitude". */
	altitude?: number;
	/** GPS altitude above sea level, kept separately because peak labels need an absolute datum. */
	altitudeAmsl?: number;
	/**
	 * Compass bearing, in degrees, of the *centre* of the equirectangular frame.
	 * Without it the sphere has no idea which way it is facing, so nothing can be
	 * labelled; with it, every direction in the image is known.
	 */
	heading?: number;
	camera?: string;
	width?: number;
	height?: number;
}

/** Bearings are compared and averaged all over the place; keep them in [0, 360). */
export function normalizeHeading(value: number): number {
	return ((value % 360) + 360) % 360;
}

const HEADER_BYTES = 256 * 1024;

const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Ifd {
	[tag: number]: number | number[] | string;
}

function readIfd(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): Ifd {
	const out: Ifd = {};
	const base = tiffStart + ifdOffset;
	if (base + 2 > view.byteLength) return out;

	const count = view.getUint16(base, little);
	for (let i = 0; i < count; i++) {
		const entry = base + 2 + i * 12;
		if (entry + 12 > view.byteLength) break;

		const tag = view.getUint16(entry, little);
		const type = view.getUint16(entry + 2, little);
		const length = view.getUint32(entry + 4, little);
		const size = TIFF_TYPE_SIZE[type];
		if (!size) continue;

		const total = size * length;
		const valueAt = total <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
		if (valueAt + total > view.byteLength) continue;

		if (type === 2) {
			let text = "";
			for (let j = 0; j < length; j++) {
				const code = view.getUint8(valueAt + j);
				if (code === 0) break;
				text += String.fromCharCode(code);
			}
			out[tag] = text.trim();
			continue;
		}

		const numbers: number[] = [];
		for (let j = 0; j < length; j++) {
			const at = valueAt + j * size;
			switch (type) {
				case 1:
				case 7:
					numbers.push(view.getUint8(at));
					break;
				case 3:
					numbers.push(view.getUint16(at, little));
					break;
				case 4:
					numbers.push(view.getUint32(at, little));
					break;
				case 9:
					numbers.push(view.getInt32(at, little));
					break;
				case 5:
					numbers.push(view.getUint32(at, little) / (view.getUint32(at + 4, little) || 1));
					break;
				case 10:
					numbers.push(view.getInt32(at, little) / (view.getInt32(at + 4, little) || 1));
					break;
				default:
					break;
			}
		}
		out[tag] = numbers.length === 1 ? numbers[0] : numbers;
	}

	return out;
}

const asNumbers = (value: Ifd[number] | undefined): number[] =>
	Array.isArray(value) ? value : typeof value === "number" ? [value] : [];

/** GPS coordinates are stored as degrees/minutes/seconds plus a N/S/E/W ref. */
function toDecimal(dms: number[], ref: unknown): number | undefined {
	if (dms.length < 3) return undefined;
	const [d, m, s] = dms;
	const value = d + m / 60 + s / 3600;
	if (!Number.isFinite(value)) return undefined;
	const negative = typeof ref === "string" && /^[SW]/i.test(ref);
	return negative ? -value : value;
}

/** EXIF dates are "YYYY:MM:DD HH:MM:SS" with no timezone. */
function toIsoDate(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const match = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s] = match;
	const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseExif(view: DataView): PanoMetadata {
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};

	let offset = 2;
	while (offset + 4 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) {
			offset++;
			continue;
		}
		const marker = view.getUint8(offset + 1);
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xda) break; // start of scan — no metadata past here

		const length = view.getUint16(offset + 2);
		if (marker === 0xe1 && offset + 10 <= view.byteLength) {
			const tag = String.fromCharCode(
				view.getUint8(offset + 4),
				view.getUint8(offset + 5),
				view.getUint8(offset + 6),
				view.getUint8(offset + 7),
			);
			if (tag === "Exif") {
				const tiff = offset + 10;
				if (tiff + 8 > view.byteLength) return {};
				const little = view.getUint16(tiff) === 0x4949;
				const ifd0 = readIfd(view, tiff, view.getUint32(tiff + 4, little), little);

				const meta: PanoMetadata = {};
				const make = typeof ifd0[0x010f] === "string" ? ifd0[0x010f] : "";
				const model = typeof ifd0[0x0110] === "string" ? ifd0[0x0110] : "";
				const camera = [make, model].filter(Boolean).join(" ").trim();
				if (camera) meta.camera = camera;

				const exifPointer = ifd0[0x8769];
				if (typeof exifPointer === "number") {
					const exif = readIfd(view, tiff, exifPointer, little);
					meta.capturedAt = toIsoDate(exif[0x9003]) ?? toIsoDate(ifd0[0x0132]);
				} else {
					meta.capturedAt = toIsoDate(ifd0[0x0132]);
				}

				const gpsPointer = ifd0[0x8825];
				if (typeof gpsPointer === "number") {
					const gps = readIfd(view, tiff, gpsPointer, little);
					meta.lat = toDecimal(asNumbers(gps[0x0002]), gps[0x0001]);
					meta.lon = toDecimal(asNumbers(gps[0x0004]), gps[0x0003]);
					const altitude = asNumbers(gps[0x0006])[0];
					if (Number.isFinite(altitude)) {
						// GPSAltitudeRef 1 means "below sea level".
						meta.altitudeAmsl = asNumbers(gps[0x0005])[0] === 1 ? -altitude : altitude;
						meta.altitude = meta.altitudeAmsl;
					}

					// GPSImgDirection is where the camera pointed. On a stitched sphere
					// that is the centre of the frame, which is exactly the reference
					// the marker layer needs.
					const direction = asNumbers(gps[0x0011])[0];
					if (Number.isFinite(direction)) meta.heading = normalizeHeading(direction);
				}

				return meta;
			}
		}

		if (length < 2) break;
		offset += 2 + length;
	}

	return {};
}

/**
 * DJI writes flight data into an XMP packet as well; `RelativeAltitude` (height
 * above the takeoff point) is far more useful for a drone shot than the GPS
 * ellipsoid altitude, so it wins when both are present.
 */
function parseXmp(bytes: Uint8Array): Partial<PanoMetadata> {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const start = text.indexOf("<x:xmpmeta");
	if (start === -1) return {};
	const packet = text.slice(start, text.indexOf("</x:xmpmeta>", start) + 12 || undefined);

	const pick = (name: string) => {
		const attr = packet.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
		if (attr) return attr[1];
		const node = packet.match(new RegExp(`<${name}>([^<]*)</${name}>`));
		return node ? node[1] : undefined;
	};

	const out: Partial<PanoMetadata> = {};
	const relative = Number(pick("drone-dji:RelativeAltitude"));
	if (Number.isFinite(relative) && relative !== 0) out.altitude = relative;

	const absolute = Number(pick("drone-dji:AbsoluteAltitude"));
	if (Number.isFinite(absolute) && absolute !== 0) out.altitudeAmsl = absolute;

	/*
	  Heading, best source first. GPano is written by the stitcher and describes
	  the finished sphere, which is the thing being labelled; the DJI yaw fields
	  describe the aircraft and only coincide with the frame centre because that
	  is where the stitch starts. Yaw is signed (-180…180), so it is normalized.
	*/
	for (const name of ["GPano:PoseHeadingDegrees", "drone-dji:GimbalYawDegree", "drone-dji:FlightYawDegree"]) {
		const raw = Number(pick(name));
		if (Number.isFinite(raw) && raw !== 0) {
			out.heading = normalizeHeading(raw);
			break;
		}
	}

	const lat = Number(pick("drone-dji:GpsLatitude") ?? pick("drone-dji:Latitude"));
	const lon = Number(pick("drone-dji:GpsLongitude") ?? pick("drone-dji:Longitude"));
	if (Number.isFinite(lat) && lat !== 0) out.lat = lat;
	if (Number.isFinite(lon) && lon !== 0) out.lon = lon;

	return out;
}

/**
 * True pixel dimensions, read from the JPEG frame header (SOF0/SOF2/…).
 *
 * Cheaper and more trustworthy than EXIF's PixelXDimension, and it means the
 * upload never has to fully decode an 8192×4096 original just to record how
 * big it was.
 */
function parseDimensions(view: DataView): { width?: number; height?: number } {
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return {};

	let offset = 2;
	while (offset + 4 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) {
			offset++;
			continue;
		}
		const marker = view.getUint8(offset + 1);
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xda) break;

		const length = view.getUint16(offset + 2);
		// SOF0–SOF15, skipping the DHT/JPG/DAC markers interleaved in that range.
		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrame && offset + 9 <= view.byteLength) {
			return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
		}

		if (length < 2) break;
		offset += 2 + length;
	}

	return {};
}

export async function readPanoMetadata(file: File): Promise<PanoMetadata> {
	try {
		const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
		const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
		return { ...parseExif(view), ...parseXmp(head), ...parseDimensions(view) };
	} catch {
		return {};
	}
}
