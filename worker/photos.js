/**
 * Panorama API + image delivery, backed by a single R2 bucket.
 *
 * Bucket layout
 *   thumbs/<id>     small webp card image — ALSO the metadata record for <id>
 *   previews/<id>   ~4096px webp the sphere viewer actually loads
 *   photos/<id>     the untouched original straight off the drone
 *
 * All metadata lives in the thumb's `customMetadata`. Thumbs are tens of
 * kilobytes, so editing a title is a cheap re-put; doing the same on a 40 MB
 * original would mean rewriting the whole object. One `list({prefix:'thumbs/'})`
 * therefore returns the entire gallery — no KV, no D1, no per-item GET.
 */

import { verifyAccess } from './access.js';

const KINDS = {
	thumb: { prefix: 'thumbs/', maxBytes: 2 * 1024 * 1024 },
	/** 1200×630 horizon crop, used only as the link-preview card. */
	cover: { prefix: 'covers/', maxBytes: 4 * 1024 * 1024 },
	preview: { prefix: 'previews/', maxBytes: 40 * 1024 * 1024 },
	original: { prefix: 'photos/', maxBytes: 200 * 1024 * 1024 },
};

const ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(init.headers || {}) },
	});

const fail = (status, message) => json({ error: message }, { status });

/** customMetadata values must be strings; drop anything empty so we don't store "undefined". */
function toCustomMetadata(meta) {
	const out = {};
	for (const [k, v] of Object.entries(meta)) {
		if (v === undefined || v === null || v === '') continue;
		out[k] = String(v).slice(0, 900);
	}
	return out;
}

function toPhoto(object) {
	const id = object.key.slice(KINDS.thumb.prefix.length);
	const m = object.customMetadata || {};
	return {
		id,
		title: m.title || '',
		description: m.description || '',
		capturedAt: m.capturedAt || '',
		uploadedAt: m.uploadedAt || object.uploaded?.toISOString?.() || '',
		lat: m.lat ? Number(m.lat) : null,
		lon: m.lon ? Number(m.lon) : null,
		altitude: m.altitude ? Number(m.altitude) : null,
		width: m.width ? Number(m.width) : null,
		height: m.height ? Number(m.height) : null,
		bytes: m.bytes ? Number(m.bytes) : null,
		/** Size of the camera file this was made from, when it differs from what we keep. */
		sourceBytes: m.sourceBytes ? Number(m.sourceBytes) : null,
		camera: m.camera || '',
		originalName: m.originalName || '',
		thumb: `/~/img/thumb/${id}`,
		cover: `/~/img/cover/${id}`,
		preview: `/~/img/preview/${id}`,
		original: `/~/img/original/${id}`,
	};
}

async function listAll(bucket) {
	const photos = [];
	let cursor;
	do {
		const page = await bucket.list({ prefix: KINDS.thumb.prefix, include: ['customMetadata'], cursor, limit: 1000 });
		for (const object of page.objects) photos.push(toPhoto(object));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	// IDs are `<capture timestamp>-<rand>`, so a reverse lexical sort is newest-first.
	photos.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	return photos;
}

async function serveImage(request, env, kind, id) {
	const spec = KINDS[kind];
	if (!spec || !ID_RE.test(id)) return fail(404, 'Not found');

	const key = spec.prefix + id;
	const range = request.headers.get('Range');
	const get = (k) =>
		env.PHOTOS.get(k, {
			range: range ? request.headers : undefined,
			onlyIf: request.headers,
		});

	const object = await get(key);

	if (object === null) return fail(404, 'Not found');

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('ETag', object.httpEtag);
	headers.set('Cache-Control', IMMUTABLE);
	headers.set('Accept-Ranges', 'bytes');

	// `get` with `onlyIf` returns a body-less R2Object when the precondition fails.
	if (!('body' in object) || object.body === null) {
		return new Response(null, { status: request.headers.get('If-None-Match') ? 304 : 412, headers });
	}

	// Only a requested range gets a 206 — R2 reports a range on a full read too.
	if (range && object.range && 'offset' in object.range) {
		const start = object.range.offset ?? 0;
		const length = object.range.length ?? object.size - start;
		headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
		return new Response(object.body, { status: 206, headers });
	}

	if (kind === 'original') {
		// The archive is WebP unless the browser could not beat the camera file,
		// in which case the camera file was stored verbatim — name it accordingly.
		const ext = (object.httpMetadata?.contentType || '').includes('webp') ? 'webp' : 'jpg';
		headers.set('Content-Disposition', `inline; filename="${id}.${ext}"`);
	}
	return new Response(object.body, { headers });
}

async function handleUpload(request, env, kind, id) {
	const spec = KINDS[kind];
	if (!spec) return fail(400, `Unknown upload kind "${kind}"`);
	if (!ID_RE.test(id)) return fail(400, 'Invalid photo id');
	if (!request.body) return fail(400, 'Empty upload body');

	const declared = Number(request.headers.get('Content-Length') || 0);
	if (declared > spec.maxBytes) {
		return fail(413, `${kind} exceeds the ${Math.round(spec.maxBytes / 1024 / 1024)} MB limit`);
	}

	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
	if (!contentType.startsWith('image/')) return fail(415, 'Only image uploads are accepted');

	/** Metadata rides along on the thumb PUT, base64url-encoded so headers stay ASCII. */
	let customMetadata;
	if (kind === 'thumb') {
		const raw = request.headers.get('X-Photo-Meta');
		if (!raw) return fail(400, 'Thumb upload is missing X-Photo-Meta');
		try {
			const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
			const meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
			customMetadata = toCustomMetadata({ ...meta, uploadedAt: new Date().toISOString() });
		} catch {
			return fail(400, 'Unreadable X-Photo-Meta');
		}
	}

	await env.PHOTOS.put(spec.prefix + id, request.body, {
		httpMetadata: { contentType, cacheControl: IMMUTABLE },
		customMetadata,
	});

	return json({ ok: true, id, kind });
}

async function handlePatch(request, env, id) {
	if (!ID_RE.test(id)) return fail(400, 'Invalid photo id');

	const existing = await env.PHOTOS.get(KINDS.thumb.prefix + id);
	if (!existing) return fail(404, 'Not found');

	const patch = await request.json().catch(() => null);
	if (!patch || typeof patch !== 'object') return fail(400, 'Expected a JSON object');

	const next = { ...(existing.customMetadata || {}) };
	for (const field of ['title', 'description']) {
		if (field in patch) next[field] = patch[field] == null ? '' : String(patch[field]);
	}

	await env.PHOTOS.put(KINDS.thumb.prefix + id, existing.body, {
		httpMetadata: existing.httpMetadata,
		customMetadata: toCustomMetadata(next),
	});

	return json({ ok: true, id });
}

async function handleDelete(env, id) {
	if (!ID_RE.test(id)) return fail(400, 'Invalid photo id');
	await env.PHOTOS.delete(Object.values(KINDS).map((k) => k.prefix + id));
	return json({ ok: true, id });
}

/**
 * `/~/api/*` — JSON. Reads are public, writes require a valid Access assertion.
 */
export async function handleApi(request, env) {
	const { pathname } = new URL(request.url);
	const segments = pathname.slice('/~/api/'.length).split('/').filter(Boolean);
	const [resource, ...rest] = segments;
	const method = request.method.toUpperCase();

	if (resource === 'photos' && rest.length === 0 && (method === 'GET' || method === 'HEAD')) {
		return json({ photos: await listAll(env.PHOTOS) });
	}

	// Everything past this point mutates the archive.
	const auth = await verifyAccess(request, env);

	if (resource === 'whoami') {
		return json(auth.ok ? { authorized: true, email: auth.email } : { authorized: false, reason: auth.reason });
	}

	if (!auth.ok) return fail(403, auth.reason);

	if (resource === 'upload' && rest.length === 2 && method === 'PUT') {
		const [id, kind] = rest;
		return handleUpload(request, env, kind, id);
	}

	if (resource === 'photos' && rest.length === 1) {
		if (method === 'DELETE') return handleDelete(env, rest[0]);
		if (method === 'PATCH') return handlePatch(request, env, rest[0]);
	}

	return fail(404, `No API route for ${method} ${pathname}`);
}

/**
 * `/~/img/<kind>/<id>` — the bytes themselves, cached immutably at the edge.
 */
export async function handleImage(request, env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'Method not allowed');
	const { pathname } = new URL(request.url);
	const [kind, id] = pathname.slice('/~/img/'.length).split('/');
	return serveImage(request, env, kind, id);
}
