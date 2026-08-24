# Site Specification

## Configuration
- **Site Type**: General (personal media archive)
- **Target Audience**: Anyone following the work publicly; a single authenticated uploader (the owner)
- **Primary Goal**: Credibility — show the panoramas as well as they can be shown on a phone
- **Domain**: https://dji.dz0ny.dev
- **Infrastructure**: Astro 6 static output on Cloudflare Workers · R2 bucket `PHOTOS` (auto-provisioned binding) · Cloudflare Access gates all writes

## Design Direction
- **Direction**: a light/dark pair chosen by the reader's OS — "Paper Sky" under `prefers-color-scheme: light`, "Dark Room" under dark. There is no in-page switch; the system setting *is* the switch.
- **Base Language**: Dark + Minimalist
- **Dials**: VARIANCE 6 · MOTION 5 · DENSITY 3
- **Palette** (60/30/10): dominant `hsl(210.8 32.8% 6.3%)` cool blue-slate near-black · secondary `#00d6e7` sky cyan · accent `#eb7289` coral — triadic with the third (olive) leg deliberately held in reserve
- **Fonts**: Bricolage Grotesque 400–800 (display) / Public Sans 300–700 (body) / JetBrains Mono 400–700 (meta) — via Astro Fonts API
- **Signature patterns**: split-stage hero (live sphere behind a bottom-left title block and a bottom-right monospace stat rail); asymmetric gallery grid where the newest frame and every seventh card span double width
- **Motion recipes**: staggered `rise` on hero entry; IntersectionObserver reveal on gallery cards; slow autorotate on the hero sphere — all short-circuited under `prefers-reduced-motion`

### The pair
Both directions ship as complete token sets in `src/index.css`. Paper Sky is declared on bare `:root` (so a browser
reporting no preference gets the half that reads on any screen); Dark Room is declared under
`@media (prefers-color-scheme: dark)`. `<meta name="color-scheme" content="light dark">` hands the same choice to
scrollbars, form controls, and the overscroll canvas, and two `theme-color` metas carry one colour each.

Nothing is applied by script, so there is no flash and nothing to persist — the localStorage-backed switcher and its
`DirectionSwitch.astro` component were removed when the pair replaced the trio.

- **Paper Sky** (light) — near-white cool paper, Fraunces display, cobalt `#0052a5` accent, radius 0.25rem, DENSITY 2
- **Dark Room** (dark) — cool blue-slate near-black, Bricolage display, sky-cyan `#00d6e7` primary, radius 0.875rem, DENSITY 3

Each is a whole identity rather than a recolour, so flipping the OS setting changes typeface, density, and corner
radius along with the palette. That is deliberate: both were designed as complete directions and both were kept.

**"Flight Log"** — the warm-black amber third direction — was cut. It survives only in git history.

`data-direction` still pins either direction on any subtree, which is how `/branding/` shows both at once. That needs
one extra thing to work: `@theme` declares `--color-background: hsl(var(--background))` on `:root`, and a custom
property's `var()` is substituted where the property is *declared*, not where it is used — so the mapping is computed
once, at the root, and descendants inherit a finished colour. Setting `--background` deeper down does nothing by
itself. `src/index.css` therefore re-binds every `--color-*` / `--font-*` / `--spacing-*` token inside a
`[data-direction]` block. Without it a pinned subtree silently renders in the root's palette.

## Architecture Notes
- `output: "static"` — every page is prerendered, so the gallery, hero, and viewer fetch `/~/api/photos` client-side. `import.meta.env` is empty at runtime; nothing secret may live under `src/`.
- `run_worker_first = ["/~*"]` — the JSON API and image delivery reach `worker/index.js`; every other path is served straight from `dist/client/` by Cloudflare's asset layer and never enters Worker code. Two routes exist: `/~/api/` and `/~/img/`.
- All panorama metadata lives in the **thumb** object's R2 `customMetadata`, so one `list({prefix:'thumbs/'})` renders the whole gallery — no KV, no D1.
- Every derivative is generated **in the browser** before upload; the Worker never processes pixels. One decode feeds all four: a full-resolution WebP archive (same pixels as the camera JPEG, ~⅓ the bytes, so zoom loses nothing), a 4096px preview the sphere loads, a 1200×630 social card cropped to a 110° slice of the horizon, and an 800px thumb.
- Upload order is cover → preview → original → thumb, so a half-finished upload leaves orphan bytes rather than a broken gallery card.
- `public/og.jpg` is the site-wide link-preview card, built from the sample panorama by `bun run og` with the same crop geometry. **Every page currently serves this one card**, including `/view/`. Per-panorama previews are stored (`/~/img/cover/<id>`) but not yet wired: the asset layer ignores query strings, so `/view/?id=…` would have to be re-fetched through the `ASSETS` binding by a Worker route that rewrites the Open Graph tags. That route does not exist.
- `bun run dev` builds and runs the **real Worker** under `wrangler dev` with a local R2 — there is one implementation and one route table, identical to production. The only local difference is `ACCESS_DEV_BYPASS=1` in `.dev.vars` (never deployed), which stands in for the Access layer that only exists in front of the live domain.

### Naming
- Uploads name themselves. `worker/place.js` (`/~/api/place?lat=&lon=`) turns coordinates into a place name and `src/lib/upload.ts` uses it as the title whenever nothing was typed in; failure is silent, and an untitled panorama still falls back to its capture date everywhere it is shown.
- **A named summit wins.** Nominatim will never give you one — asked about Snežnik it answers with the municipality 15 km down the valley, or, at a tighter zoom, the forest track under the trees. So the baked peak index the horizon labels already run on is asked first, and any named top within **400 m** becomes the title. Everything else falls through to Nominatim `reverse` at `zoom=14`, which picks the most specific of hamlet → village → town → city → municipality → county.
- Answers are cached in R2 under `places/` keyed to ~110 m, so a valley flown twenty times is one lookup. Misses are cached too — otherwise every unnamed spot would be re-asked forever.
- The route sits **behind the Access check** with the other write-side routes: an open geocoding proxy is somebody else’s rate limit to burn. The reverse-geocode runs in the Worker rather than the browser because OSM asks clients to identify themselves with a `User-Agent`, which a page cannot set.
- `/admin/` carries a per-photo **Geo** button beside Edit and Del that runs the same lookup on demand and confirms before renaming — the geocoder picks the nearest named thing, which is not always what the photo is of. It is disabled on any panorama with no coordinates.

### Map
- `/map/` uses **Leaflet 1.9**, imported by the page script rather than the layout — it is ~150 kB and no other route needs it. Tiles come straight from `tile.openstreetmap.org`, the same key-less host `staticmap.ts` already uses for the in-viewer minimap.
- Pins are `divIcon`s, not Leaflet's default PNG marker: the bundled image paths break under Vite, and a CSS dot takes the direction's brand colour, a frame count, and the heading tick for free.
- Photos within ~11 m of each other (lat/lon rounded to four decimals) collapse into one pin whose popup lists them all — repeat flights from the same take-off point would otherwise stack into an unclickable pile.
- `fitBounds` is deferred to the next animation frame after `invalidateSize()`. Leaflet measures the container when `L.map()` runs, which is before the grid has laid out; a stale size makes it fall back to the whole world.
- OSM ships one bright raster set, so the two dark directions invert the **tiles only** (`invert hue-rotate brightness contrast saturate`) back into the palette. Paper Sky leaves them alone.
- A bare mouse wheel scrolls the page; ⌘/Ctrl + wheel zooms. On touch, one finger pans — this page *is* the map, unlike the spheres embedded in the scrolling gallery.
- A "Sites" rail listing every take-off point was built alongside the map and removed: the pins and their popups already answer everything it did, and it cost the map a fifth of the page.

### Viewer
- Photo Sphere Viewer 5.15.1. `core`, `gyroscope`, and `autorotate` load for every sphere; `map` and `resolution` (with its required `settings`) are opt-in props on `PanoViewer.astro` and code-split behind a dynamic `import()`, so the gallery hero never pays for them. Their stylesheets are imported **statically** — bundling them with the dynamic import emitted `<link>` tags for CSS chunks the build never wrote.
- The minimap has no geo awareness of its own and every hosted static-map API needs a key, which cannot live in `src/` on a static build. `src/lib/staticmap.ts` therefore composes a 3×3 OpenStreetMap tile grid onto a canvas at view time, draws the required attribution into the pixels, and hands the plugin an object URL plus the pin's pixel offset. A failed tile fetch costs the minimap, never the panorama.
- The quality switch offers the 4096px preview and the full-resolution archive, labelled with its byte count so the cost of the second rung is visible before it is paid.
- Chrome is restyled to the site's tokens rather than left at plugin defaults: the minimap's 34px corner buttons shrink to 26px and its zoom readout is hidden while it is a minimap (pinch and wheel still zoom), both returning at full size once maximized.
- iPhone Safari has no Fullscreen API, so PSV emulates it with a fixed-position class. That only presents correctly once the page's own stacking context yields — the fix is CSS (`:has()` on the wrapper, `100dvh`, a body scroll lock, and fading the page chrome out), not a second fullscreen implementation.

## Design Evolution
- **2026-08-17** — Initial build. Three directions proposed and all three realized at the user's request.
- **2026-08-17** — User asked for a theme switcher: all three directions ship as a runtime-switchable theme rather than one locked choice. (Superseded 2026-08-24.)
- **2026-08-17** — Mobile pass: a header menu holding Gallery, Upload, and the theme switch (the switch is gone as of 2026-08-24); the hero stat rail stopped wrapping and gallery card meta stopped overflowing at 334px.
- **2026-08-18** — Fullscreen fixed on iPhone Safari, and the map + resolution plugins added to the viewer with their chrome sized for a phone.
- **2026-08-18** — Settings button no longer keeps its active tint after a pick: choosing an option calls the settings *component*'s `hide()` rather than the plugin's `hideSettings()`, so the button never learns the menu closed. Cleared explicitly; the active state now inverts the disc instead of tinting the glyph the same accent the badge already uses.
- **2026-08-24** — Uploads name themselves from where they were flown: nearest baked summit within 400 m, else an OSM reverse geocode. `/admin/` gained a per-photo Geo button that does the same on demand.
- **2026-08-24** — `/map/` added: every geotagged panorama on one Leaflet map, pins grouped per take-off point. Its signature is the camera's own display language — a live lat/lon/zoom telemetry readout in the frame, and a heading tick on any pin whose photo recorded which way the frame faced. Viewfinder corner marks were built and cut: they read as decoration and collided with the zoom control.
- **2026-08-24** — Cut to a light/dark pair driven by `prefers-color-scheme`: Flight Log removed, the header theme switcher removed with it. Fixed a pre-existing bug this surfaced — `[data-direction]` subtrees had never actually re-themed, because Tailwind's `--color-*` mapping resolves once at `:root`.
- **Current style**: Paper Sky in light mode, Dark Room in dark, following the reader's system setting.
