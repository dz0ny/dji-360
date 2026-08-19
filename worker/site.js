/**
 * Constants the worker shares with the prerendered site.
 *
 * `src/config.ts` is TypeScript compiled into the static build and never runs in
 * workerd, so the one value the share route needs is mirrored here. Keep it in
 * step with `SITE_NAME` in `src/config.ts`. URLs are built from the request
 * origin instead, so a preview deployment previews itself.
 */

export const SITE_NAME = 'dji.dz0ny.dev';
