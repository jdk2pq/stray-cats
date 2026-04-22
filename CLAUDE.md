# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

DC Kitten Finder — a GitHub Pages map app showing stray kittens in DC pulled from the Petango/PetPoint shelter API. No framework, no bundler, no test suite. The entire frontend is a single `index.html`.

## Running locally

Open `index.html` directly in a browser, or serve it with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

No install step required — `package.json` only declares `"type": "module"`.

## Running the data scripts

**Seed (one-time bulk geocode, run locally before first deploy):**
```bash
GOOGLE_GEOCODING_KEY=AIza... node seed-coords.js
```

**Nightly update (normally runs via GitHub Actions, but can be triggered manually):**
```bash
node .github/scripts/update-coords.js
```
The nightly script will abort if it finds more than 20 new addresses — that's a signal to run `seed-coords.js` locally instead.

## Architecture

### Data flow

```
Petango API (XML)
    ↓
update-coords.js / seed-coords.js
    ↓  merge into
animals.json          coords.json
    ↓  fetched by
index.html (browser)
    ↓  renders
Google Maps + sidebar list
```

### `animals.json`

Keyed by Petango animal ID. Records are **never deleted** — the nightly script only adds or updates. Merge rules in `mergeRecord()`:
- `alwaysUpdate`: `lastSeenDate`, `location`, `possibleMother`, `spayedNeutered`, `photo`
- `neverUpdate`: `firstSeenDate`, `id`
- Everything else: take fresh value only if non-empty; keep existing if fresh is blank/NaN

### `coords.json`

Maps `fullAddr` (e.g. `"123 Main St, Washington, DC"`) → `{lat, lng}` or `null`. `null` means geocoding was attempted and failed — it won't be retried nightly (intentional, prevents hammering Nominatim for bad addresses).

### Mother matching

During each update run, adult females found at the same address on the same date as a kitten are annotated as `possibleMother`. Confidence is `"likely"` — inferred, not confirmed. The youngest matching adult is preferred.

### DC boundary overlay

Fetched at runtime from `benbalter/dc-maps` on GitHub. A polygon mask darkens everything outside DC, with an orange stroke on the DC border. If the fetch fails, the map still works without the overlay.

### Google Maps API key

The key (`AIzaSyC1v...`) is hardcoded in `index.html` near the bottom in the Maps script tag. This is intentional — client-side Maps keys are inherently public and should be restricted by HTTP referrer in the Google Cloud Console, not kept secret.

## Key constraints

- **Nominatim rate limit**: 1 request/second enforced via `sleep(1100)` in the nightly script. Do not remove this delay.
- **Nightly script max addresses**: Hard-capped at 20 new addresses per run. Bulk geocoding must go through `seed-coords.js` (Google API, no meaningful rate limit).
- **No CI linting or type checking** — there is no automated check on `index.html` JavaScript. Changes must be manually tested in a browser.
- **GitHub Actions writes back to `main`** — the workflow has `contents: write` permission and auto-commits `animals.json` and `coords.json`.

## Deployment

The app deploys automatically via GitHub Pages from the `main` branch root. No build step. Pushing any change to `main` is a deploy.
