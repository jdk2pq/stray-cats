#!/usr/bin/env node
// geocode-2026-addresses.js
// ONE-TIME script: geocode the addresses in historical_data/2026.csv (a plain,
// already-deduplicated list of street addresses with no coordinates) via the
// Google Geocoding API, and cache the results.
//
// Run locally:
//   GOOGLE_GEOCODING_KEY=your_key_here node geocode-2026-addresses.js

import fs from 'fs';

const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_KEY;
if (!GOOGLE_KEY) {
  console.error('Error: set the GOOGLE_GEOCODING_KEY environment variable first.');
  console.error('  Example: GOOGLE_GEOCODING_KEY=AIza... node geocode-2026-addresses.js');
  process.exit(1);
}

const CSV_FILE = 'historical_data/2026.csv';
const COORDS_FILE = 'historical-2026-coords.json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const CITY_STATE_SUFFIX = ', Washington, DC'; // 2026.csv has bare street addresses only

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Returns { lat, lng } | null (genuinely not found) | 'RETRY' (transient
// failure — quota/rate-limit/network — must NOT be cached as a permanent miss).
async function geocode(address, attempt = 1) {
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results[0]) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    if (data.status === 'ZERO_RESULTS') return null;

    console.warn(`    Google status: ${data.status}`);
    if (attempt < 5) {
      const backoffMs = 2000 * attempt;
      console.warn(`    Retrying in ${backoffMs}ms (attempt ${attempt + 1}/5)...`);
      await sleep(backoffMs);
      return geocode(address, attempt + 1);
    }
    console.warn(`    Giving up after 5 attempts — will retry next run.`);
    return 'RETRY';
  } catch (e) {
    console.warn(`    Geocode error: ${e.message}`);
    return 'RETRY';
  }
}

function readAddresses() {
  return fs.readFileSync(CSV_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

async function main() {
  const addresses = readAddresses();

  let coords = {};
  if (fs.existsSync(COORDS_FILE)) {
    try {
      coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(coords).length} existing cached addresses.`);
    } catch { console.warn('Could not parse historical-2026-coords.json — starting fresh.'); }
  }

  const newAddresses = addresses.filter(a => !(a in coords));
  console.log(`${addresses.length} addresses in 2026.csv, ${newAddresses.length} not yet geocoded.\n`);

  if (!newAddresses.length) {
    console.log('historical-2026-coords.json already up to date.');
    return;
  }

  let succeeded = 0, failed = 0, deferred = 0;
  for (let i = 0; i < newAddresses.length; i++) {
    const address = newAddresses[i];
    const fullAddr = `${address}${CITY_STATE_SUFFIX}`;
    process.stdout.write(`[${i + 1}/${newAddresses.length}] ${fullAddr} ... `);
    const result = await geocode(fullAddr);
    if (result === 'RETRY') {
      deferred++;
      console.log('… deferred (will retry next run)');
    } else if (result) {
      coords[address] = result;
      succeeded++;
      console.log(`✓ ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`);
    } else {
      coords[address] = null;
      failed++;
      console.log('✗ not found');
    }
    if ((i + 1) % 10 === 0) fs.writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2));
    await sleep(250);
  }

  fs.writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2));
  console.log(`\nDone.`);
  console.log(`  Geocoded: ${succeeded} succeeded, ${failed} not found, ${deferred} deferred for retry`);
  console.log(`  Total in historical-2026-coords.json: ${Object.keys(coords).length}`);
  if (deferred) console.log(`\n${deferred} addresses hit persistent errors — just re-run this script to retry them.`);
  console.log(`\nNow run: node build-historical-trapping.js`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
