/**
 * Cloudflare Access JWT verification.
 *
 * Access puts a signed JWT on every request that passes its policy, in the
 * `Cf-Access-Jwt-Assertion` header (also mirrored into the `CF_Authorization`
 * cookie). Verifying it here means the write API is safe even if someone
 * reaches the Worker on a path Access does not cover — e.g. the workers.dev
 * hostname, which Access policies on the custom domain do not protect.
 *
 * Fails closed everywhere: nothing is authorized without a valid assertion,
 * except when `ACCESS_DEV_BYPASS` is set. That variable lives only in
 * `.dev.vars`, which wrangler reads exclusively for `wrangler dev` and never
 * uploads, so the branch cannot exist on the deployed Worker.
 */

const JWKS_TTL_MS = 60 * 60 * 1000;

/** @type {{ host: string, fetchedAt: number, keys: Map<string, CryptoKey> } | null} */
let jwksCache = null;

function b64urlToBytes(input) {
	const b64 = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function b64urlToJson(input) {
	return JSON.parse(new TextDecoder().decode(b64urlToBytes(input)));
}

async function loadKeys(teamDomain) {
	const host = teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
	if (jwksCache && jwksCache.host === host && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
		return jwksCache.keys;
	}

	const res = await fetch(`https://${host}/cdn-cgi/access/certs`, {
		cf: { cacheTtl: 3600, cacheEverything: true },
	});
	if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
	const { keys: jwks } = await res.json();

	const keys = new Map();
	for (const jwk of jwks ?? []) {
		if (jwk.kty !== 'RSA') continue;
		const key = await crypto.subtle.importKey(
			'jwk',
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify'],
		);
		keys.set(jwk.kid, key);
	}

	jwksCache = { host, fetchedAt: Date.now(), keys };
	return keys;
}

/**
 * Verify the Access assertion on a request.
 *
 * @returns {Promise<{ ok: true, email: string } | { ok: false, reason: string }>}
 */
export async function verifyAccess(request, env) {
	// Local development: there is no Access in front of `wrangler dev`, so don't
	// pretend there is one — uploads go straight to the local R2 simulation.
	// Comes from `.dev.vars`, which never reaches a deploy.
	if (env.ACCESS_DEV_BYPASS === '1') return { ok: true, email: 'dev@localhost' };

	const aud = (env.ACCESS_AUD || '').trim();
	const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').trim();
	if (!aud || !teamDomain) return { ok: false, reason: 'Access is not configured on this Worker' };

	const cookieToken = (request.headers.get('Cookie') || '')
		.split(';')
		.map((c) => c.trim())
		.find((c) => c.startsWith('CF_Authorization='))
		?.slice('CF_Authorization='.length);
	const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookieToken;

	if (!token) return { ok: false, reason: 'No Access token on request' };

	const parts = token.split('.');
	if (parts.length !== 3) return { ok: false, reason: 'Malformed Access token' };
	const [rawHeader, rawPayload, rawSignature] = parts;

	let header;
	let payload;
	try {
		header = b64urlToJson(rawHeader);
		payload = b64urlToJson(rawPayload);
	} catch {
		return { ok: false, reason: 'Unreadable Access token' };
	}

	if (header.alg !== 'RS256') return { ok: false, reason: `Unexpected token alg ${header.alg}` };

	const keys = await loadKeys(teamDomain);
	const key = keys.get(header.kid);
	if (!key) return { ok: false, reason: 'Unknown signing key' };

	const verified = await crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		b64urlToBytes(rawSignature),
		new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
	);
	if (!verified) return { ok: false, reason: 'Bad token signature' };

	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp === 'number' && payload.exp < now) return { ok: false, reason: 'Token expired' };
	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return { ok: false, reason: 'Token not yet valid' };

	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!audiences.includes(aud)) return { ok: false, reason: 'Token audience mismatch' };

	const expectedIss = `https://${teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
	if (payload.iss !== expectedIss) return { ok: false, reason: 'Token issuer mismatch' };

	return { ok: true, email: payload.email || 'unknown' };
}
