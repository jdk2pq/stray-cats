#!/usr/bin/env node
// geocode-cluster-addresses.js
// ONE-TIME script: extract the addresses named inside each "N calls / M locations"
// cluster feature of dc-community-cats-targeted-trapping.geojson, geocode any that
// aren't already cached, and write cluster-coords.json.
//
// Run locally:
//   GOOGLE_GEOCODING_KEY=your_key_here node geocode-cluster-addresses.js

import fs from 'fs';

const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_KEY;
if (!GOOGLE_KEY) {
  console.error('Error: set the GOOGLE_GEOCODING_KEY environment variable first.');
  console.error('  Example: GOOGLE_GEOCODING_KEY=AIza... node geocode-cluster-addresses.js');
  process.exit(1);
}

const GEOJSON_FILE = 'dc-community-cats-targeted-trapping.geojson';
const CLUSTER_COORDS_FILE = 'cluster-coords.json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Returns { lat, lng } | null (address genuinely not found) | 'RETRY' (transient
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

    // OVER_QUERY_LIMIT, UNKNOWN_ERROR, etc. are transient — back off and retry
    // rather than caching a false "not found".
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

function extractClusterAddresses(geojson) {
  const addresses = new Set();
  for (const feature of geojson.features) {
    const name = feature.properties?.name || '';
    if (!/calls\s*\/\s*.*locations/i.test(name)) continue;
    const desc = feature.properties?.description || '';
    const re = /<li>(.*?)\s*—\s*\d+\s*calls?<\/li>/g;
    let m;
    while ((m = re.exec(desc)) !== null) addresses.add(m[1].trim());
  }
  return [...addresses];
}

async function main() {
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_FILE, 'utf8'));

  let clusterCoords = {};
  if (fs.existsSync(CLUSTER_COORDS_FILE)) {
    try {
      clusterCoords = JSON.parse(fs.readFileSync(CLUSTER_COORDS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(clusterCoords).length} existing cached cluster addresses.`);
    } catch { console.warn('Could not parse cluster-coords.json — starting fresh.'); }
  }

  const addresses = extractClusterAddresses(geojson);
  const newAddresses = addresses.filter(a => !(a in clusterCoords));
  console.log(`${addresses.length} unique cluster addresses, ${newAddresses.length} not yet geocoded.\n`);

  if (!newAddresses.length) {
    console.log('cluster-coords.json already up to date.');
    return;
  }

  let succeeded = 0, failed = 0, deferred = 0;
  for (let i = 0; i < newAddresses.length; i++) {
    const address = newAddresses[i];
    process.stdout.write(`[${i + 1}/${newAddresses.length}] ${address} ... `);
    const result = await geocode(address);
    if (result === 'RETRY') {
      deferred++;
      console.log('… deferred (will retry next run)');
    } else if (result) {
      clusterCoords[address] = result;
      succeeded++;
      console.log(`✓ ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`);
    } else {
      clusterCoords[address] = null;
      failed++;
      console.log('✗ not found');
    }
    // Save incrementally so a crash or Ctrl+C doesn't lose progress.
    if ((i + 1) % 10 === 0) fs.writeFileSync(CLUSTER_COORDS_FILE, JSON.stringify(clusterCoords, null, 2));
    await sleep(250);
  }

  fs.writeFileSync(CLUSTER_COORDS_FILE, JSON.stringify(clusterCoords, null, 2));
  console.log(`\nDone.`);
  console.log(`  Geocoded: ${succeeded} succeeded, ${failed} not found, ${deferred} deferred for retry`);
  console.log(`  Total in cluster-coords.json: ${Object.keys(clusterCoords).length}`);
  if (deferred) console.log(`\n${deferred} addresses hit persistent errors — just re-run this script to retry them.`);
  console.log(`\nNow run: node build-clusters.js`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
