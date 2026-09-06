#!/usr/bin/env node
// build-historical-trapping.js
// ONE-TIME build script: combine historical_data/2025.csv (already geocoded,
// with duplicate rows) and historical_data/2026.csv (deduplicated addresses,
// no coordinates — see geocode-2026-addresses.js) into a lean
// historical-trapping.json for index.html to render as two toggleable
// year layers. Neither CSV is part of the nightly Petango sync; this is a
// manual, one-off dataset.
//
// Run locally, after geocode-2026-addresses.js:
//   node build-historical-trapping.js

import fs from 'fs';

const CSV_2025 = 'historical_data/2025.csv';
const CSV_2026 = 'historical_data/2026.csv';
const COORDS_2026_FILE = 'historical-2026-coords.json';
const OUTPUT_FILE = 'historical-trapping.json';

// Small RFC-4180-ish CSV parser — needed because some addresses in 2025.csv
// contain commas and are quoted (e.g. `"Richmond, VA",37.52...`); a naive
// split(',') misaligns those rows' columns.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function parseCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}

function build2025() {
  const rows = parseCsv(fs.readFileSync(CSV_2025, 'utf8'));
  const seen = new Map(); // address (upper) -> { address, lat, lng }
  const conflicts = [];

  for (const row of rows) {
    const address = row.Address;
    const lat = parseFloat(row.Latitude);
    const lng = parseFloat(row.Longitude);
    if (!address || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const key = address.toUpperCase();
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (existing.lat !== lat || existing.lng !== lng) {
        conflicts.push({ address, kept: { lat: existing.lat, lng: existing.lng }, discarded: { lat, lng } });
      }
      continue; // first occurrence wins, deterministically
    }
    seen.set(key, { address, lat, lng });
  }

  if (conflicts.length) {
    console.warn(`2025.csv: ${conflicts.length} address(es) had inconsistent coordinates across duplicate rows — kept the first occurrence for each:`);
    for (const c of conflicts) {
      console.warn(`  "${c.address}": kept (${c.kept.lat}, ${c.kept.lng}), discarded (${c.discarded.lat}, ${c.discarded.lng})`);
    }
  }

  return [...seen.values()];
}

function build2026() {
  const addresses = fs.readFileSync(CSV_2026, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const coords = fs.existsSync(COORDS_2026_FILE)
    ? JSON.parse(fs.readFileSync(COORDS_2026_FILE, 'utf8'))
    : {};

  const points = [];
  let missing = 0;
  for (const address of addresses) {
    const coord = coords[address];
    if (!coord) { missing++; continue; }
    points.push({ address, lat: coord.lat, lng: coord.lng });
  }

  if (missing) {
    console.warn(`2026.csv: ${missing} address(es) not yet geocoded (or geocode failed) — run geocode-2026-addresses.js first.`);
  }

  return points;
}

function main() {
  const year2025 = build2025();
  const year2026 = build2026();

  const output = {
    generatedAt: new Date().toISOString(),
    year2025,
    year2026,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${OUTPUT_FILE}`);
  console.log(`  2025: ${year2025.length} unique addresses`);
  console.log(`  2026: ${year2026.length} geocoded addresses`);
}

main();
