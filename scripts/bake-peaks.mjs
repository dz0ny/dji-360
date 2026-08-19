/**
 * Bake the summit index into R2.
 *
 * The viewer's peak labels used to start with a live Overpass query per
 * panorama: ~35 seconds on the cold path, rate-limited, and occasionally a 504
 * that left a photo with no labels until someone reloaded. OSM is still the
 * right name source — nothing else names the 700 m wooded tops that fill the
 * middle distance — but there is no reason to ask it at request time. The data
 * only changes when a mapper edits it, and the archive only covers one corner
 * of Europe.
 *
 * So: one pass over a bounding box, one degree at a time, missing heights
 * filled from a terrain model, the result written to R2 as a grid of cells the
 * Worker can read directly. Re-run it whenever you want fresher OSM data.
 *
 *   bun scripts/bake-peaks.mjs                     # the default box
 *   bun scripts/bake-peaks.mjs --bbox=44,12,48,18  # minLat,minLon,maxLat,maxLon
 *   bun scripts/bake-peaks.mjs --dry-run           # build locally, upload nothing
 *
 * Overpass answers are cached under .cache/peaks/, so a re-run after a failure
 * costs nothing but the cells that never made it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

/** Slovenia with enough margin that a 60 km horizon never leaves the box. */
const DEFAULT_BBOX = [44, 12, 48, 18];

const BUCKET = 'dji-360-photos';
const PREFIX = 'peaks/grid/v1/';
const CACHE_DIR = '.cache/peaks';
const OUT_DIR = '.cache/peaks/out';

const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'dji.dz0ny.dev peak index (+https://dji.dz0ny.dev)';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bboxArg = args.find((a) => a.startsWith('--bbox='));
const BBOX = bboxArg ? bboxArg.slice('--bbox='.length).split(',').map(Number) : DEFAULT_BBOX;
if (BBOX.length !== 4 || BBOX.some((n) => !Number.isFinite(n))) {
	console.error('--bbox wants minLat,minLon,maxLat,maxLon');
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** OSM `ele` is free text: "1796", "1796 m", "1,796", occasionally nonsense. */
function toElevation(raw) {
	if (typeof raw !== 'string') return null;
	const value = Number.parseFloat(raw.replace(',', '.'));
	return Number.isFinite(value) && value > -500 && value < 9000 ? value : null;
}

async function overpass(query) {
	let lastError;
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const endpoint of OVERPASS_ENDPOINTS) {
			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					body: `data=${encodeURIComponent(query)}`,
					headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
				});
				if (!res.ok) {
					lastError = new Error(`${endpoint} replied ${res.status}`);
					// A busy instance answers 429/504 immediately; backing off is the
					// only thing that helps, and the other mirror is usually busy too.
					await sleep(5000 * (attempt + 1));
					continue;
				}
				return await res.json();
			} catch (error) {
				lastError = error;
			}
		}
	}
	throw lastError ?? new Error('Overpass unreachable');
}

/** One degree of latitude by one of longitude, named for its south-west corner. */
async function fetchCell(latCell, lonCell) {
	const name = `${latCell}_${lonCell}`;
	const cached = await readFile(`${CACHE_DIR}/${name}.json`, 'utf8').catch(() => null);
	if (cached) return { name, peaks: JSON.parse(cached), cached: true };

	const query = `[out:json][timeout:180];node(${latCell},${lonCell},${latCell + 1},${lonCell + 1})["natural"~"^(peak|hill|volcano)$"]["name"];out qt;`;
	const body = await overpass(query);

	const peaks = [];
	for (const element of body.elements || []) {
		const label = element.tags?.name;
		if (!label || element.lat == null) continue;
		peaks.push({ name: label, lat: element.lat, lon: element.lon, ele: toElevation(element.tags?.ele) });
	}

	await writeFile(`${CACHE_DIR}/${name}.json`, JSON.stringify(peaks));
	return { name, peaks, cached: false };
}

/**
 * Fill in the heights OSM never recorded.
 *
 * Open-Meteo samples Copernicus GLO-90 at 100 coordinates per request. It puts
 * a summit a few metres low — it reads a grid cell, not the cairn — but the
 * alternative is dropping the peak, which is why the horizon used to show only
 * the famous mountains.
 */
async function fillElevations(peaks) {
	const missing = peaks.filter((peak) => peak.ele == null);
	if (!missing.length) return;

	for (let i = 0; i < missing.length; i += 100) {
		const batch = missing.slice(i, i + 100);
		const latitudes = batch.map((peak) => peak.lat.toFixed(5)).join(',');
		const longitudes = batch.map((peak) => peak.lon.toFixed(5)).join(',');
		try {
			const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${latitudes}&longitude=${longitudes}`);
			if (!res.ok) {
				await sleep(2000);
				continue;
			}
			const values = (await res.json())?.elevation;
			if (Array.isArray(values)) {
				batch.forEach((peak, index) => {
					if (Number.isFinite(values[index])) peak.ele = values[index];
				});
			}
		} catch {
			// Whatever resolved stays; the rest are dropped by the caller.
		}
		await sleep(250);
		process.stdout.write(`\r    elevations ${Math.min(i + 100, missing.length)}/${missing.length}`);
	}
	process.stdout.write('\n');
}

function run(command, commandArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		child.stderr.on('data', (chunk) => (err += chunk));
		child.stdout.on('data', () => {});
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${command} exited ${code}`))));
	});
}

async function upload(key, file) {
	await run('bunx', [
		'wrangler',
		'r2',
		'object',
		'put',
		`${BUCKET}/${key}`,
		`--file=${file}`,
		'--content-type=application/json',
		'--remote',
	]);
}

const [minLat, minLon, maxLat, maxLon] = BBOX;
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

const cells = [];
let total = 0;

for (let latCell = Math.floor(minLat); latCell < Math.ceil(maxLat); latCell++) {
	for (let lonCell = Math.floor(minLon); lonCell < Math.ceil(maxLon); lonCell++) {
		const { name, peaks, cached } = await fetchCell(latCell, lonCell);
		if (!cached) await sleep(2000); // Overpass asks for a pause between queries.
		if (!peaks.length) {
			console.log(`  ${name}: empty`);
			continue;
		}

		console.log(`  ${name}: ${peaks.length} named tops${cached ? ' (cached)' : ''}`);
		await fillElevations(peaks);

		const usable = peaks.filter((peak) => peak.ele != null);
		// Coordinates to five decimals is ~1 m, and it halves the object.
		const compact = usable.map((peak) => ({
			name: peak.name,
			lat: Number(peak.lat.toFixed(5)),
			lon: Number(peak.lon.toFixed(5)),
			ele: Math.round(peak.ele),
		}));

		const file = `${OUT_DIR}/${name}.json`;
		await writeFile(file, JSON.stringify(compact));
		if (!dryRun) await upload(`${PREFIX}${name}.json`, file);

		cells.push(name);
		total += compact.length;
	}
}

const index = {
	version: 1,
	builtAt: new Date().toISOString(),
	bbox: [minLat, minLon, maxLat, maxLon],
	cells,
	peaks: total,
};

const indexFile = `${OUT_DIR}/index.json`;
await writeFile(indexFile, JSON.stringify(index));
if (!dryRun) await upload(`${PREFIX}index.json`, indexFile);

console.log(`\n${total} peaks across ${cells.length} cells${dryRun ? ' (dry run, nothing uploaded)' : ' → r2://' + BUCKET + '/' + PREFIX}`);
