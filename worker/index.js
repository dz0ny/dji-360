/**
 * Cloudflare Workers Entry Point
 *
 * Handles requests before serving static assets from the Astro build.
 * `run_worker_first` in wrangler.toml decides what reaches this code — the
 * `/~*` API and image paths. Everything else is served straight from `dist/` by
 * Cloudflare's asset layer and never enters the worker.
 */

import { handleApi, handleImage } from './photos.js';

/**
 * Route handlers map
 * Key: route prefix, Value: { handler, description }
 */
const ROUTES = {
	'/~/api/': { handler: handleApi, description: 'Panorama JSON API' },
	'/~/img/': { handler: handleImage, description: 'Panorama image delivery' },
};

/**
 * Main worker fetch handler
 */
export default {
	async fetch(request, env, ctx) {
		const pathname = new URL(request.url).pathname;

		const route = Object.entries(ROUTES).find(([prefix]) => pathname.startsWith(prefix));

		if (route) {
			const [, { handler, description }] = route;
			try {
				return await handler(request, env, ctx);
			} catch (error) {
				console.error(`Error in ${description}:`, error);
				return new Response('Internal Server Error', { status: 500 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},
};
