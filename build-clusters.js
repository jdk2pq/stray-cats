#!/usr/bin/env node
// build-clusters.js
// ONE-TIME build script: combine dc-community-cats-targeted-trapping.geojson
// (a one-off export, not part of the nightly Petango sync) with cluster-coords.json
// into a lean clusters.json that index.html can render directly, without parsing
// HTML <description> strings in the browser.
//
// Run locally, after geocode-cluster-addresses.js:
//   node build-clusters.js

import fs from 'fs';

const GEOJSON_FILE = 'dc-community-cats-targeted-trapping.geojson';
const CLUSTER_COORDS_FILE = 'cluster-coords.json';
const OUTPUT_FILE = 'clusters.json';

function parseClusterFeature(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const name = feature.properties.name; // e.g. "16 calls / 9 locations"
  const m = name.match(/(\d+)\s*calls?\s*\/\s*(\d+)\s*locations?/i);
  const calls = m ? parseInt(m[1], 10) : null;
  const locations = m ? parseInt(m[2], 10) : null;

  const desc = feature.properties.description || '';
  const addrRe = /<li>(.*?)\s*—\s*(\d+)\s*calls?<\/li>/g;
  const addresses = [];
  let am;
  while ((am = addrRe.exec(desc)) !== null) {
    addresses.push({ address: am[1].trim(), calls: parseInt(am[2], 10) });
  }

  return {
    id: feature.id,
    calls,
    locations,
    center: { lat, lng },
    addresses,
    // Raw source fields, kept verbatim so the UI can show exactly what the
    // original geojson feature said when this cluster point is clicked.
    rawName: name,
    rawDescription: desc,
  };
}

// Non-cluster features come in two shapes that look superficially similar but
// carry different information — a real case/activity record from the shelter's
// case system, or a "repeat caller" summary for one address that never grouped
// into a 500ft cluster (too few nearby addresses, or below the 3-call cluster
// minimum). Distinguishing them (rather than parsing both with one case-shaped
// regex) is what was silently dropping the repeat-caller data before.
const CASE_RE = /^<b>(.*?)<\/b><br\/>Case: <b>(.*?)<\/b><br\/>Activity: (.*?)<br\/>Status: <b>(.*?)<\/b><br\/>Activity number: (\d+)$/;
const CALL_RE = /^<b>(.*?)<\/b><br\/>Calls at this matched location: <b>(\d+)<\/b><br\/>Call dates: (.*?)<br\/>ZIP: (.*)$/;

function parseIndividualFeature(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  const desc = feature.properties.description || '';

  const caseMatch = desc.match(CASE_RE);
  if (caseMatch) {
    const [, address, caseNumber, activity, status, activityNumber] = caseMatch;
    return {
      id: feature.id,
      kind: 'case',
      address: address.trim(),
      caseNumber,
      activity: activity.trim(),
      status,
      activityNumber,
      lat,
      lng,
    };
  }

  const callMatch = desc.match(CALL_RE);
  if (callMatch) {
    const [, address, calls, callDates, zip] = callMatch;
    return {
      id: feature.id,
      kind: 'call',
      address: address.trim(),
      calls: parseInt(calls, 10),
      callDates: callDates.trim(),
      zip: zip.trim(),
      lat,
      lng,
    };
  }

  console.warn(`  Unrecognized individual feature description shape (id ${feature.id}): ${desc.slice(0, 80)}...`);
  return { id: feature.id, kind: 'unknown', address: '', lat, lng };
}

function main() {
  const geojson = JSON.parse(fs.readFileSync(GEOJSON_FILE, 'utf8'));
  const clusterCoords = fs.existsSync(CLUSTER_COORDS_FILE)
    ? JSON.parse(fs.readFileSync(CLUSTER_COORDS_FILE, 'utf8'))
    : {};

  const clusterFeatures = geojson.features.filter(f => /calls\s*\/\s*.*locations/i.test(f.properties?.name || ''));
  const individualFeatures = geojson.features.filter(f => !/calls\s*\/\s*.*locations/i.test(f.properties?.name || ''));

  const rawReports = individualFeatures.map(parseIndividualFeature);

  // The same physical address can appear both as a cluster sub-address and as
  // an individual report, each carrying its own independently-geocoded lat/lng
  // (ours via Google for clusters, the source geojson's own for reports) —
  // which can disagree by up to ~1km. Rather than lose either geocode, we keep
  // both files on disk untouched and just pick ONE canonical coordinate per
  // address to actually plot, so the two layers never show the same address
  // in two different spots. The report's coordinate wins when available,
  // since it's the source dataset's own per-case geocode; cluster-coords.json
  // (our Google geocode) is only a fallback for addresses no report covers.
  const reportCoordsByAddress = {};
  for (const r of rawReports) {
    if (!r.address) continue;
    const key = r.address.trim().toUpperCase();
    if (!(key in reportCoordsByAddress)) reportCoordsByAddress[key] = { lat: r.lat, lng: r.lng };
  }

  // A single address can show up as BOTH a case/activity record and a
  // repeat-caller summary (e.g. a trapping case plus a separate 311-style call
  // log for the same spot) — as two geojson features at the identical lat/lng.
  // Left as separate markers they'd stack exactly on top of each other and
  // only the topmost would ever be clickable. Group them into one marker per
  // address instead, carrying all of that address's records together.
  const reportsByAddress = new Map();
  for (const { kind, id, address, lat, lng, ...fields } of rawReports) {
    const key = address ? address.trim().toUpperCase() : `__no_address_${id}`;
    if (!reportsByAddress.has(key)) reportsByAddress.set(key, { address, lat, lng, records: [] });
    reportsByAddress.get(key).records.push({ kind, id, ...fields });
  }
  const reports = [...reportsByAddress.values()];

  let missingGeocode = 0;
  const clusters = clusterFeatures.map(f => {
    const cluster = parseClusterFeature(f);
    cluster.addresses = cluster.addresses
      .map(a => {
        const coord = reportCoordsByAddress[a.address.trim().toUpperCase()] || clusterCoords[a.address];
        if (!coord) { missingGeocode++; return null; }
        return { ...a, lat: coord.lat, lng: coord.lng };
      })
      .filter(Boolean);
    return cluster;
  });

  const output = {
    generatedAt: new Date().toISOString(),
    clusters,
    reports,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`  ${clusters.length} clusters (${missingGeocode} sub-addresses skipped — not yet geocoded or geocode failed)`);
  console.log(`  ${reports.length} individual report markers (from ${rawReports.length} source records, grouped by address)`);
}

main();
