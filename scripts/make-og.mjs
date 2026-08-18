/**
 * Builds `public/og.jpg`, the default link-preview card.
 *
 * Same geometry as `deriveCover` in `src/lib/derive.ts`: an equirectangular
 * image maps degrees to pixels linearly, so a 110°-wide slice centred on the
 * frame is the view the sphere opens at — a photograph rather than a squashed
 * globe. Kept as a script rather than an `astro:assets` import because scrapers
 * need a stable, unhashed URL.
 *
 * Run with `bun run og` after changing the sample panorama.
 */
import sharp from "sharp";

const SOURCE = "src/assets/sample-pano.jpg";
const OUT = "public/og.jpg";
const [W, H, FOV] = [1200, 630, 110];

const image = sharp(SOURCE);
const { width, height } = await image.metadata();

const sw = Math.round((width * FOV) / 360);
const sh = Math.min(Math.round(sw / (W / H)), height);

await image
	.extract({
		left: Math.round((width - sw) / 2),
		top: Math.round((height - sh) / 2),
		width: sw,
		height: sh,
	})
	.resize(W, H)
	.jpeg({ quality: 84, mozjpeg: true })
	.toFile(OUT);

console.log(`${OUT} — ${W}×${H} from a ${FOV}° crop of ${width}×${height}`);
