/**
 * `/p/<id>/` — the shareable URL for a single panorama.
 *
 * The viewer itself is a prerendered static page, so its `<head>` can only ever
 * carry the site-wide card: anything shared pointed at `/view/` and previewed as
 * the generic gallery. This route serves that same prerendered shell, but with
 * the head rewritten from the photo's R2 metadata — real title, description,
 * canonical URL and its own 1200×630 cover image.
 *
 * Metadata lives in the thumb's `customMetadata` (see photos.js), so a share
 * hit is a single `head()` on a tens-of-kilobytes object — no listing, no body.
 */

import { SITE_NAME } from './site.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;

/** The prerendered chromeless viewer, reused as the shell for every photo. */
const SHELL_PATH = '/view/';

function formatDate(raw) {
	if (!raw) return '';
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function formatCoords(lat, lon) {
	if (lat === '' || lon === '' || lat == null || lon == null) return '';
	const a = Number(lat);
	const o = Number(lon);
	if (Number.isNaN(a) || Number.isNaN(o)) return '';
	return `${Math.abs(a).toFixed(4)}°${a >= 0 ? 'N' : 'S'} ${Math.abs(o).toFixed(4)}°${o >= 0 ? 'E' : 'W'}`;
}

/** Everything the head needs, derived from what the upload stored. */
function cardFor(id, meta, origin) {
	const date = formatDate(meta.capturedAt || meta.uploadedAt);
	const coords = formatCoords(meta.lat, meta.lon);
	const title = meta.title || date || 'Panorama';

	const facts = [date, coords, meta.camera].filter(Boolean).join(' · ');
	const description =
		meta.description || `A 360° aerial panorama${facts ? ` — ${facts}` : ''}. Drag, pinch, or tilt your phone to look around.`;

	return {
		title: `${title} | ${SITE_NAME}`,
		description,
		url: `${origin}/p/${id}/`,
		/* Older uploads predate `covers/`; their thumb is the only card we have. */
		image: `${origin}/~/img/${meta.hasCover ? 'cover' : 'thumb'}/${id}`,
		imageAlt: `360° panorama — ${title}`,
		imageWidth: meta.hasCover ? '1200' : '800',
		imageHeight: meta.hasCover ? '630' : '400',
	};
}

/** Rewrites the values of the head tags Layout.astro already emits. */
function rewriteHead(response, card) {
	const set = (attr, value) => ({
		element(el) {
			el.setAttribute(attr, value);
		},
	});

	return new HTMLRewriter()
		/* The bare `/view/` shell is noindex; a real panorama is a page worth having. */
		.on('meta[name="robots"]', {
			element(el) {
				el.remove();
			},
		})
		.on('title', {
			element(el) {
				el.setInnerContent(card.title);
			},
		})
		.on('link[rel="canonical"]', set('href', card.url))
		.on('meta[name="description"]', set('content', card.description))
		.on('meta[property="og:title"]', set('content', card.title))
		.on('meta[property="og:description"]', set('content', card.description))
		.on('meta[property="og:url"]', set('content', card.url))
		.on('meta[property="og:type"]', set('content', 'article'))
		.on('meta[property="og:image"]', set('content', card.image))
		.on('meta[property="og:image:alt"]', set('content', card.imageAlt))
		.on('meta[property="og:image:width"]', set('content', card.imageWidth))
		.on('meta[property="og:image:height"]', set('content', card.imageHeight))
		.on('meta[name="twitter:title"]', set('content', card.title))
		.on('meta[name="twitter:description"]', set('content', card.description))
		.on('meta[name="twitter:image"]', set('content', card.image))
		.transform(response);
}

export async function handlePano(request, env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405 });
	}

	const url = new URL(request.url);
	const segments = url.pathname.slice('/p/'.length).split('/').filter(Boolean);
	const id = segments[0] ?? '';

	if (segments.length !== 1 || !ID_RE.test(id)) return shellOr404(env, url, 404);

	// Trailing slash everywhere else on the site; keep one canonical form here too.
	if (!url.pathname.endsWith('/')) {
		return Response.redirect(`${url.origin}/p/${id}/${url.search}`, 301);
	}

	const [thumb, cover] = await Promise.all([env.PHOTOS.head(`thumbs/${id}`), env.PHOTOS.head(`covers/${id}`)]);
	if (!thumb) return shellOr404(env, url, 404);

	const shell = await env.ASSETS.fetch(new URL(SHELL_PATH, url.origin));
	if (!shell.ok) return shell;

	const card = cardFor(id, { ...(thumb.customMetadata || {}), hasCover: Boolean(cover) }, url.origin);

	const headers = new Headers(shell.headers);
	// Short enough that a retitled photo re-previews soon, long enough that a
	// burst of scrapers on a fresh share does not hit R2 once each.
	headers.set('Cache-Control', 'public, max-age=300');
	headers.delete('ETag');

	return rewriteHead(new Response(shell.body, { status: 200, headers }), card);
}

/** Unknown ids get the site's own 404 page rather than a bare string. */
async function shellOr404(env, url, status) {
	const res = await env.ASSETS.fetch(new URL('/404.html', url.origin));
	if (!res.ok) return new Response('Not Found', { status });
	return new Response(res.body, { status, headers: res.headers });
}
