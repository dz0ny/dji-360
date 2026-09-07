/**
 * Browser-side reel rendering: one equirectangular panorama in, one 15-second
 * MP4 out — portrait for a story, landscape for everywhere else — with nothing
 * leaving the device.
 *
 * Same bargain as `derive.ts` — the Worker has no ffmpeg and no encoding plan,
 * so the machine that wants the video makes it. A fragment shader re-projects
 * the sphere frame by frame and WebCodecs encodes the result, which means the
 * whole clip is produced as fast as the GPU and the hardware encoder allow
 * rather than in real time: fifteen seconds of video takes a few seconds.
 *
 * The projection is its own shader rather than a screengrab of Photo Sphere
 * Viewer because the two want opposite things. PSV renders a sphere from the
 * inside at whatever size its container happens to be, and its "fisheye" is a
 * vertex displacement that cannot reach a true little planet. Here every output
 * pixel casts a ray, so the frame is exactly the size asked for regardless of
 * the window — a phone held in portrait produces the same file as a desktop,
 * and the same panorama renders to either aspect without re-framing by hand.
 */

import {
	BufferTarget,
	CanvasSource,
	canEncodeVideo,
	Mp4OutputFormat,
	Output,
	Quality,
} from "mediabunny";

export const REEL = {
	fps: 30,
	seconds: 15,
	/**
	 * Render at 2× and let the 2D canvas box-filter it down. The little planet
	 * squeezes a whole 4096px equirectangular into a disc a few hundred pixels
	 * across, which without supersampling crawls with aliasing along every roof
	 * line. Mipmaps would be the cheaper fix, but the longitude seam is a wrap
	 * in the texture coordinate and its derivative explodes there, so a mipmapped
	 * sphere grows a blurred vertical scar down the middle of the planet.
	 */
	supersample: 2,
} as const;

/**
 * The two shapes worth exporting, and where the caption can safely sit in each.
 *
 * `safeBottom` is the distance from the bottom edge that the caption baseline
 * keeps clear of. On a story that is not typography, it is Instagram: the reply
 * bar and the swipe-up affordance own roughly the bottom 250px of a 1920px
 * frame on every phone that opens it, so a caption any lower is a caption
 * nobody reads. A wide clip is posted somewhere with no such overlay and only
 * needs an ordinary margin.
 */
export const REEL_FORMATS = {
	story: { label: "Story", ratio: "9:16", width: 1080, height: 1920, safeBottom: 300 },
	wide: { label: "Wide", ratio: "16:9", width: 1920, height: 1080, safeBottom: 96 },
} as const;

export type ReelFormat = keyof typeof REEL_FORMATS;

const FRAMES = REEL.fps * REEL.seconds;
const DEG = Math.PI / 180;

/**
 * The three beats of the clip, in seconds.
 *
 * A tiny planet is the shape that says "this is a 360° photo" in the half-second
 * someone gives a story, and a horizon sweep is the only way to actually show
 * what was photographed. The unroll between them is what ties the two together —
 * without it the cut reads as two unrelated clips.
 */
const UNROLL_START = 4;
const UNROLL_END = 6;

/**
 * Stereographic straight down: the whole sphere curled into a globe.
 *
 * 100° across the short edge is what makes it read as a planet. The horizon —
 * everything at 90° from straight down — is the disc's rim, so the half-angle
 * chosen here is directly how much sky surrounds it: at 100° the ground fills
 * about six-sevenths of the frame with a thin band of sky around it, and by
 * 135° the planet has shrunk to a marble adrift in blue.
 */
const PLANET = { pitch: -90 * DEG, planet: 1, halfAngle: 100 * DEG };

/**
 * Eye level, with a quarter of the fisheye left in. Fully rectilinear at this
 * field of view stretches the corners of a tall frame badly, and a trace of
 * curvature keeps the horizon reading as part of a sphere.
 */
const HORIZON = { pitch: -6 * DEG, planet: 0.28, halfAngle: 52 * DEG };

/**
 * `uScale` is the tangent of the half field of view measured up the frame, so
 * the same number frames the two aspects completely differently. Each pose
 * therefore names the axis it actually cares about and the scale is solved for
 * the format in hand.
 *
 * The planet is measured across the **short** axis: the disc should touch the
 * near edges with the corners running out past it into sky, which is what makes
 * it read as a globe rather than as a circle pasted on black. The horizon is
 * measured along the **long** axis, because that is the direction the sweep
 * travels and the one that decides how much of the view is in frame.
 */
function scaleFor(
	pose: { planet: number; halfAngle: number },
	aspect: number,
	axis: "short" | "long",
): number {
	// Both projections at the extremes; a blended pose lands between them, and
	// the framing error in the middle of the unroll is not something an eye can
	// catch on a moving camera.
	const radius = pose.planet > 0.5 ? 2 * Math.tan(pose.halfAngle / 2) : Math.tan(pose.halfAngle);
	return axis === "short" ? radius / Math.min(aspect, 1) : radius / Math.max(aspect, 1);
}

/** How much of the clip is spent getting up to speed, and slowing down again. */
const YAW_EASE = 1.2 / REEL.seconds;

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

/**
 * Inverse projection: screen pixel → view ray → longitude/latitude → texel.
 *
 * `uPlanet` blends the two angle-from-axis laws rather than the images they
 * produce. Both are monotonic in the screen radius, so every value in between
 * is itself a valid projection — which is what makes the unroll a single
 * continuous camera move instead of a cross-fade between two renders.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uPano;
uniform vec2 uResolution;
uniform float uYaw;
uniform float uPitch;
uniform float uScale;
uniform float uPlanet;

out vec4 outColor;

const float PI = 3.141592653589793;

void main() {
  // Normalised so the vertical half-height is 1; uScale then *is* the tangent
  // of the half field of view, and the frame's aspect follows from the width.
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / (0.5 * uResolution.y) * uScale;
  float r = length(p);

  float theta = mix(atan(r), 2.0 * atan(r * 0.5), uPlanet);
  vec3 dir = r < 1e-6 ? vec3(0.0, 0.0, -1.0) : vec3(sin(theta) * p / r, -cos(theta));

  float cp = cos(uPitch), sp = sin(uPitch);
  dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);

  float cy = cos(uYaw), sy = sin(uYaw);
  dir = vec3(cy * dir.x - sy * dir.z, dir.y, sy * dir.x + cy * dir.z);

  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  outColor = texture(uPano, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}`;

interface Pose {
	yaw: number;
	pitch: number;
	scale: number;
	planet: number;
}

interface Framing {
	planetScale: number;
	horizonScale: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/**
 * Yaw for every frame, as one continuous 360° turn.
 *
 * Built by integrating a speed profile rather than easing the angle directly:
 * an ease over the whole clip would sprint through the middle, and the middle is
 * the horizon sweep, which is the part worth watching. This ramps up, holds a
 * constant speed for the bulk of the clip, and settles, so the clip neither
 * starts nor ends on a lurch — which matters because a story autoplays straight
 * into its own first frame when the reader taps back.
 */
function yawPerFrame(): number[] {
	const speeds = Array.from({ length: FRAMES }, (_, frame) => {
		const t = frame / (FRAMES - 1);
		return smoothstep(0, YAW_EASE, t) * smoothstep(0, YAW_EASE, 1 - t);
	});

	const total = speeds.reduce((sum, speed) => sum + speed, 0);
	let travelled = 0;
	return speeds.map((speed) => {
		const yaw = (travelled / total) * 2 * Math.PI;
		travelled += speed;
		return yaw;
	});
}

function poseAt(frame: number, yaw: number, framing: Framing): Pose {
	const seconds = frame / REEL.fps;
	const unrolled = smoothstep(UNROLL_START, UNROLL_END, seconds);
	const between = (from: number, to: number) => from + (to - from) * unrolled;
	return {
		yaw,
		pitch: between(PLANET.pitch, HORIZON.pitch),
		scale: between(framing.planetScale, framing.horizonScale),
		planet: between(PLANET.planet, HORIZON.planet),
	};
}

/** Compiled program plus the uniform slots the frame loop writes every frame. */
interface Projector {
	draw: (pose: Pose) => void;
	dispose: () => void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("Could not create the reel shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(`Could not compile the reel shader: ${gl.getShaderInfoLog(shader)}`);
	}
	return shader;
}

function createProjector(canvas: HTMLCanvasElement, pano: ImageBitmap): Projector {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		// The 2D canvas reads this one back with drawImage after the frame is
		// rendered, which is a separate task from the browser's point of view.
		preserveDrawingBuffer: true,
	});
	if (!gl) throw new Error("This browser cannot render the reel (no WebGL2)");

	const program = gl.createProgram();
	if (!program) throw new Error("Could not create the reel shader");
	const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
	const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`Could not link the reel shader: ${gl.getProgramInfoLog(program)}`);
	}
	// biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram is not a React hook; the rule only matches on the name.
	gl.useProgram(program);

	// One triangle covering the clip space, so every pixel of the frame runs the
	// fragment shader exactly once.
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	const position = gl.getAttribLocation(program, "aPosition");
	gl.enableVertexAttribArray(position);
	gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pano);
	// Longitude wraps, so the seam at ±180° filters across correctly; latitude
	// does not, and clamping is what keeps the poles from bleeding round.
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

	const uniforms = {
		pano: gl.getUniformLocation(program, "uPano"),
		resolution: gl.getUniformLocation(program, "uResolution"),
		yaw: gl.getUniformLocation(program, "uYaw"),
		pitch: gl.getUniformLocation(program, "uPitch"),
		scale: gl.getUniformLocation(program, "uScale"),
		planet: gl.getUniformLocation(program, "uPlanet"),
	};

	gl.uniform1i(uniforms.pano, 0);
	gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
	gl.viewport(0, 0, canvas.width, canvas.height);

	return {
		draw(pose) {
			gl.uniform1f(uniforms.yaw, pose.yaw);
			gl.uniform1f(uniforms.pitch, pose.pitch);
			gl.uniform1f(uniforms.scale, pose.scale);
			gl.uniform1f(uniforms.planet, pose.planet);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		},
		dispose() {
			gl.deleteTexture(texture);
			gl.deleteBuffer(buffer);
			gl.deleteProgram(program);
			gl.deleteShader(vertex);
			gl.deleteShader(fragment);
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		},
	};
}

/** What gets burned into the bottom of the frame. Both lines are optional. */
export interface ReelCaption {
	title: string;
	meta: string;
}

function cssFont(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Title and credit, inside the format's safe area.
 *
 * Type is sized off the short edge rather than in fixed pixels, so the block
 * occupies the same fraction of a 1080-tall wide clip as of a 1080-wide story
 * — the alternative is a caption that is comfortable in one aspect and shouting
 * in the other.
 */
function drawCaption(
	ctx: CanvasRenderingContext2D,
	format: (typeof REEL_FORMATS)[ReelFormat],
	caption: ReelCaption,
	site: string,
) {
	const unit = Math.min(format.width, format.height) / 1080;
	const bottom = format.height - format.safeBottom;
	const left = 72 * unit;

	const scrimTop = bottom - 260 * unit;
	const scrim = ctx.createLinearGradient(0, scrimTop, 0, format.height);
	scrim.addColorStop(0, "rgba(0,0,0,0)");
	scrim.addColorStop(1, "rgba(0,0,0,0.72)");
	ctx.fillStyle = scrim;
	ctx.fillRect(0, scrimTop, format.width, format.height - scrimTop);

	ctx.textBaseline = "alphabetic";
	ctx.textAlign = "left";

	if (caption.meta) {
		ctx.font = `500 ${26 * unit}px ${cssFont("--type-meta", "ui-monospace, monospace")}`;
		ctx.fillStyle = "rgba(255,255,255,0.72)";
		ctx.letterSpacing = `${4 * unit}px`;
		ctx.fillText(caption.meta.toUpperCase(), left, bottom);
		ctx.letterSpacing = "0px";
	}

	if (caption.title) {
		ctx.font = `800 ${68 * unit}px ${cssFont("--type-display", "Georgia, serif")}`;
		ctx.fillStyle = "#fff";
		ctx.fillText(caption.title, left, bottom - 46 * unit);
	}

	ctx.font = `500 ${24 * unit}px ${cssFont("--type-meta", "ui-monospace, monospace")}`;
	ctx.fillStyle = "rgba(34,211,238,0.9)";
	ctx.letterSpacing = `${4 * unit}px`;
	ctx.fillText(site.toUpperCase(), left, bottom + 46 * unit);
	ctx.letterSpacing = "0px";
}

export interface ReelOptions {
	/** Equirectangular texture. The 4K preview is plenty for a 1080-wide frame. */
	panorama: string;
	format: ReelFormat;
	caption: ReelCaption;
	/** Wordmark burned under the caption. */
	site: string;
	/** 0–1, called once per encoded frame. */
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
}

/**
 * True when this browser can produce the file at all.
 *
 * H.264 specifically, not "any codec": the point of the button is a video that
 * can be dropped straight into Instagram, and a VP9 MP4 is a file that plays
 * fine locally and is rejected on upload. Better to hide the button than to
 * hand someone a story they cannot post.
 */
export async function canRenderReel(): Promise<boolean> {
	if (typeof VideoEncoder === "undefined") return false;
	try {
		// Both formats are the same pixel count in the other order, so an encoder
		// that takes one takes the other — checking the taller of the two is
		// enough, and it is the one with the larger single dimension.
		return await canEncodeVideo("avc", { width: 1080, height: 1920 });
	} catch {
		return false;
	}
}

async function loadPanorama(url: string, signal?: AbortSignal): Promise<ImageBitmap> {
	const res = await fetch(url, { signal });
	if (!res.ok) throw new Error(`Could not load the panorama (${res.status})`);
	return createImageBitmap(await res.blob());
}

/**
 * Render and encode the whole clip. Resolves with an MP4 ready to be saved.
 *
 * Frames are produced as fast as `source.add` will take them — awaiting it is
 * what applies the encoder's own backpressure, and is the difference between a
 * few seconds of work and a tab that balloons to a gigabyte holding 450
 * unencoded 1080×1920 frames.
 */
export async function renderReel(options: ReelOptions): Promise<Blob> {
	const { panorama, caption, site, onProgress, signal } = options;
	const format = REEL_FORMATS[options.format];
	const aspect = format.width / format.height;
	const framing: Framing = {
		planetScale: scaleFor(PLANET, aspect, "short"),
		horizonScale: scaleFor(HORIZON, aspect, "long"),
	};

	if (!(await canRenderReel())) {
		throw new Error("This browser cannot encode video (needs WebCodecs with H.264)");
	}

	// The caption is drawn with the site's own faces; asking for them after the
	// first frame is already encoded would change the type mid-clip.
	await document.fonts?.ready;

	const pano = await loadPanorama(panorama, signal);

	const source = document.createElement("canvas");
	source.width = format.width * REEL.supersample;
	source.height = format.height * REEL.supersample;

	const frame = document.createElement("canvas");
	frame.width = format.width;
	frame.height = format.height;
	const ctx = frame.getContext("2d", { alpha: false });
	if (!ctx) throw new Error("This browser cannot compose the reel (no 2D canvas)");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	const projector = createProjector(source, pano);

	const output = new Output({
		format: new Mp4OutputFormat({
			// Puts the index at the front of the file, which is what lets a phone
			// start playing — and an upload form start reading — before the whole
			// thing has been transferred.
			fastStart: "in-memory",
		}),
		target: new BufferTarget(),
	});

	const track = new CanvasSource(frame, {
		codec: "avc",
		quality: new Quality("high"),
		keyFrameInterval: 2,
	});
	output.addVideoTrack(track, { frameRate: REEL.fps });

	try {
		await output.start();

		const yaws = yawPerFrame();
		for (let i = 0; i < FRAMES; i++) {
			signal?.throwIfAborted();
			projector.draw(poseAt(i, yaws[i], framing));
			ctx.drawImage(source, 0, 0, format.width, format.height);
			drawCaption(ctx, format, caption, site);
			await track.add(i / REEL.fps, 1 / REEL.fps);
			onProgress?.((i + 1) / FRAMES);
		}

		await output.finalize();
		const buffer = output.target.buffer;
		if (!buffer) throw new Error("The encoder produced no video");
		return new Blob([buffer], { type: "video/mp4" });
	} catch (error) {
		await output.cancel().catch(() => {});
		throw error;
	} finally {
		projector.dispose();
		pano.close();
	}
}

/** `Storm over Bled` → `storm-over-bled-story.mp4`. */
export function reelFilename(title: string, format: ReelFormat): string {
	const slug =
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "panorama";
	return `${slug}-${format}.mp4`;
}

/**
 * Hand the file to the reader.
 *
 * The share sheet first, because on the phone that is going to post this the
 * only useful destination is another app — a download lands in Files and needs
 * a second trip through the picker. Desktop has no share sheet worth using, and
 * falls through to a plain download.
 */
export async function saveReel(blob: Blob, filename: string, title: string): Promise<void> {
	const file = new File([blob], filename, { type: "video/mp4" });

	if (navigator.canShare?.({ files: [file] })) {
		try {
			await navigator.share({ files: [file], title });
			return;
		} catch (error) {
			// A dismissed share sheet is a decision, not a failure — don't then
			// push a download the reader just declined to make.
			if (error instanceof DOMException && error.name === "AbortError") return;
		}
	}

	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
