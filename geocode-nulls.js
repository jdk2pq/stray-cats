#!/usr/bin/env node
// geocode-nulls.js
// Finds all null entries in coords.json and retries them using the Google
// Maps Geocoding API. Run this locally after receiving a geocode-failure email.
//
//   GOOGLE_GEOCODING_KEY=AIza... node geocode-nulls.js
//
// Only null addresses are retried — already-geocoded addresses are untouched.
// Addresses that still fail remain null (they can be retried again later).

import fs from 'fs';

const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_KEY;
if (!GOOGLE_KEY) {
  console.error('Error: set the GOOGLE_GEOCODING_KEY environment variable first.');
  console.error('  Example: GOOGLE_GEOCODING_KEY=AIza... node geocode-nulls.js');
  process.exit(1);
}

const COORDS_FILE = 'coords.json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function geocode(address) {
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'OK' && data.results[0]) {
      const loc = data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
    if (data.status !== 'ZERO_RESULTS') console.warn(`    Google status: ${data.status}`);
  } catch (e) {
    console.warn(`    Geocode error: ${e.message}`);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(COORDS_FILE)) {
    console.error(`${COORDS_FILE} not found. Run from the repo root.`);
    process.exit(1);
  }

  let coords;
  try {
    coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${COORDS_FILE}: ${e.message}`);
    process.exit(1);
  }

  const nullAddresses = Object.entries(coords)
    .filter(([, v]) => v === null)
    .map(([k]) => k);

  if (!nullAddresses.length) {
    console.log('No null addresses in coords.json — nothing to do.');
    return;
  }

  console.log(`Found ${nullAddresses.length} null address(es) to retry:\n`);

  let succeeded = 0, stillFailed = 0;
  for (let i = 0; i < nullAddresses.length; i++) {
    const address = nullAddresses[i];
    process.stdout.write(`[${i + 1}/${nullAddresses.length}] ${address} ... `);
    const result = await geocode(address);
    if (result) {
      coords[address] = result;
      succeeded++;
      console.log(`✓ ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`);
    } else {
      stillFailed++;
      console.log('✗ still not found');
    }
    await sleep(100);
  }

  fs.writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2));
  console.log(`\nDone. ${succeeded} newly geocoded, ${stillFailed} still null.`);

  if (succeeded > 0) {
    console.log('\nCommit and push to apply the changes:');
    console.log('  git add coords.json && git commit -m "fix: geocode previously-null addresses" && git push');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
