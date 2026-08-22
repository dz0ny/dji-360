/**
 * `/embed/<id>/` — a frame-safe, chrome-free panorama viewer.
 *
 * The normal site denies framing. This route is the sole exception, so people
 * can add one public panorama to their own page without opening the gallery or
 * admin interface to clickjacking.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{4,63}$/;
const SHELL_PATH = '/embed/';

const EMBED_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; img-src 'self' data: blob: https:; media-src 'self' https: blob:; connect-src 'self' https: wss:; frame-src 'self' https:; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' https:; frame-ancestors *; upgrade-insecure-requests";

export async function handleEmbed(request, env) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed', { status: 405 });
	}

	const url = new URL(request.url);
	const segments = url.pathname.slice('/embed/'.length).split('/').filter(Boolean);
	const id = segments[0] ?? '';

	if (segments.length > 1 || (id && !ID_RE.test(id))) {
		return new Response('Not Found', { status: 404 });
	}

	if (id && !url.pathname.endsWith('/')) {
		return Response.redirect(`${url.origin}/embed/${id}/${url.search}`, 301);
	}

	const shell = await env.ASSETS.fetch(new URL(SHELL_PATH, url.origin));
	if (!shell.ok) return shell;

	const headers = new Headers(shell.headers);
	// This replaces the global `frame-ancestors 'none'` set for the site assets.
	headers.set('Content-Security-Policy', EMBED_CSP);
	headers.set('Cache-Control', 'public, max-age=300');
	headers.delete('ETag');

	return new Response(request.method === 'HEAD' ? null : shell.body, { status: shell.status, headers });
}
