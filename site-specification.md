# Site Specification

## Configuration
- **Site Type**: General (personal media archive)
- **Target Audience**: Anyone following the work publicly; a single authenticated uploader (the owner)
- **Primary Goal**: Credibility — show the panoramas as well as they can be shown on a phone
- **Domain**: https://dji.dz0ny.dev
- **Infrastructure**: Astro 6 static output on Cloudflare Workers · R2 bucket `PHOTOS` (auto-provisioned binding) · Cloudflare Access gates all writes

## Design Direction
- **Direction**: "Dark Room" — a darkroom for aerial work; the interface recedes so the photographs glow
- **Base Language**: Dark + Minimalist
- **Dials**: VARIANCE 6 · MOTION 5 · DENSITY 3
- **Palette** (60/30/10): dominant `hsl(210.8 32.8% 6.3%)` cool blue-slate near-black · secondary `#00d6e7` sky cyan · accent `#eb7289` coral — triadic with the third (olive) leg deliberately held in reserve
- **Fonts**: Bricolage Grotesque 400–800 (display) / Public Sans 300–700 (body) / JetBrains Mono 400–700 (meta) — via Astro Fonts API
- **Signature patterns**: split-stage hero (live sphere behind a bottom-left title block and a bottom-right monospace stat rail); asymmetric gallery grid where the newest frame and every seventh card span double width
- **Motion recipes**: staggered `rise` on hero entry; IntersectionObserver reveal on gallery cards; slow autorotate on the hero sphere — all short-circuited under `prefers-reduced-motion`

### Alternate directions — shipped as a live theme switcher
All three directions ship as complete token sets. The header carries a Dark / Log / Paper switch that sets
`data-direction` on `<html>` and persists to `localStorage`; an inline head script re-applies it before first paint.
Dark Room is the default for a first-time visitor. `/branding/` shows all three side by side as fixed
`[data-direction]` subtrees regardless of the current selection.
- **Flight Log** — warm-black, amber `#fab72a` primary, JetBrains Mono throughout, radius 0.125rem, DENSITY 6
- **Paper Sky** — near-white, Fraunces display, cobalt `#0052a5` accent, DENSITY 2

## Architecture Notes
- `output: "static"` — every page is prerendered, so the gallery, hero, and viewer fetch `/~/api/photos` client-side. `import.meta.env` is empty at runtime; nothing secret may live under `src/`.
- `run_worker_first = ["/~*"]` — the JSON API and image delivery reach `worker/index.js`; every other path is served straight from `dist/client/` by Cloudflare's asset layer and never enters Worker code. Two routes exist: `/~/api/` and `/~/img/`.
- All panorama metadata lives in the **thumb** object's R2 `customMetadata`, so one `list({prefix:'thumbs/'})` renders the whole gallery — no KV, no D1.
- Every derivative is generated **in the browser** before upload; the Worker never processes pixels. One decode feeds all four: a full-resolution WebP archive (same pixels as the camera JPEG, ~⅓ the bytes, so zoom loses nothing), a 4096px preview the sphere loads, a 1200×630 social card cropped to a 110° slice of the horizon, and an 800px thumb.
- Upload order is cover → preview → original → thumb, so a half-finished upload leaves orphan bytes rather than a broken gallery card.
- `public/og.jpg` is the site-wide link-preview card, built from the sample panorama by `bun run og` with the same crop geometry. **Every page currently serves this one card**, including `/view/`. Per-panorama previews are stored (`/~/img/cover/<id>`) but not yet wired: the asset layer ignores query strings, so `/view/?id=…` would have to be re-fetched through the `ASSETS` binding by a Worker route that rewrites the Open Graph tags. That route does not exist.
- `bun run dev` builds and runs the **real Worker** under `wrangler dev` with a local R2 — there is one implementation and one route table, identical to production. The only local difference is `ACCESS_DEV_BYPASS=1` in `.dev.vars` (never deployed), which stands in for the Access layer that only exists in front of the live domain.

### Viewer
- Photo Sphere Viewer 5.15.1. `core`, `gyroscope`, and `autorotate` load for every sphere; `map` and `resolution` (with its required `settings`) are opt-in props on `PanoViewer.astro` and code-split behind a dynamic `import()`, so the gallery hero never pays for them. Their stylesheets are imported **statically** — bundling them with the dynamic import emitted `<link>` tags for CSS chunks the build never wrote.
- The minimap has no geo awareness of its own and every hosted static-map API needs a key, which cannot live in `src/` on a static build. `src/lib/staticmap.ts` therefore composes a 3×3 OpenStreetMap tile grid onto a canvas at view time, draws the required attribution into the pixels, and hands the plugin an object URL plus the pin's pixel offset. A failed tile fetch costs the minimap, never the panorama.
- The quality switch offers the 4096px preview and the full-resolution archive, labelled with its byte count so the cost of the second rung is visible before it is paid.
- Chrome is restyled to the site's tokens rather than left at plugin defaults: the minimap's 34px corner buttons shrink to 26px and its zoom readout is hidden while it is a minimap (pinch and wheel still zoom), both returning at full size once maximized.
- iPhone Safari has no Fullscreen API, so PSV emulates it with a fixed-position class. That only presents correctly once the page's own stacking context yields — the fix is CSS (`:has()` on the wrapper, `100dvh`, a body scroll lock, and fading the page chrome out), not a second fullscreen implementation.

## Design Evolution
- **2026-08-17** — Initial build. Three directions proposed and all three realized at the user's request.
- **2026-08-17** — User asked for a theme switcher: all three directions now ship as a runtime-switchable theme rather than one locked choice.
- **2026-08-17** — Mobile pass: a header menu holding Gallery, Upload, and the theme switch; the hero stat rail stopped wrapping and gallery card meta stopped overflowing at 334px.
- **2026-08-18** — Fullscreen fixed on iPhone Safari, and the map + resolution plugins added to the viewer with their chrome sized for a phone.
- **2026-08-18** — Settings button no longer keeps its active tint after a pick: choosing an option calls the settings *component*'s `hide()` rather than the plugin's `hideSettings()`, so the button never learns the menu closed. Cleared explicitly; the active state now inverts the disc instead of tinting the glyph the same accent the badge already uses.
- **Current style**: Dark Room by default, with Flight Log and Paper Sky selectable from the header.
