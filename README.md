# Stray Cat Finder

A live map of stray cats pulled from Petango/PetPoint, with rich filtering and auto-updating coordinates.

## How it works

- **`index.html`** — the map app. Loads live stray data from Petango on every visit and plots pins using pre-geocoded coordinates from `coords.json`.
- **`coords.json`** — a cache of `address → {lat, lng}` pairs. Never needs manual editing.
- **`.github/workflows/update-coords.yml`** — a GitHub Action that runs nightly, fetches the latest strays, geocodes any new addresses via Nominatim (free, no API key), and commits the updated `coords.json` back to the repo.

## Filters available

- Free text search (name, breed, color, address)
- Year pills
- Exact date range (from / to)
- Sex
- State
- Jurisdiction
- Breed
- Color
- Holding location
- Spayed / neutered status

## Notes

- The GitHub Action runs daily at 6am UTC. You can change the schedule in `.github/workflows/update-coords.yml`.
- Nominatim requires a 1-second delay between requests — geocoding 200+ addresses takes ~4 minutes on first run, then only seconds for incremental updates.
- Addresses that fail to geocode are stored as `null` in `coords.json` so they aren't retried every night (saving time). Those cats appear in the sidebar list but have no map pin.
