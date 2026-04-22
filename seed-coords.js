#!/usr/bin/env node
// seed-coords.js
// ONE-TIME script to:
//   1. Fetch all cats from Petango, identify DC kittens, match to possible mothers
//   2. Write animals.json with possibleMother annotations
//   3. Bulk geocode all addresses using Google Geocoding API → coords.json
//
// Run locally before pushing to GitHub:
//   GOOGLE_GEOCODING_KEY=your_key_here node seed-coords.js

import fs from 'fs';

const GOOGLE_KEY = process.env.GOOGLE_GEOCODING_KEY;
if (!GOOGLE_KEY) {
  console.error('Error: set the GOOGLE_GEOCODING_KEY environment variable first.');
  console.error('  Example: GOOGLE_GEOCODING_KEY=AIza... node seed-coords.js');
  process.exit(1);
}

const AUTHKEY = '5e2qhdg1s6kqsdf8s3asnwo3ttgyxai0slvr17vdj7oq5qoiwx';
const BASE = 'https://ws.petango.com/webservices/wsAdoption.asmx';
const ANIMALS_FILE = 'animals.json';
const DC_CATS_FILE = 'dc-cats.json';
const COORDS_FILE = 'coords.json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const TARGET_STATE = 'DC';
const MAX_KITTEN_AGE_MONTHS = 5;

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

function splitBlocks(xml) {
  const blocks = [];
  const re = /<an\b[^>]*>([\s\S]*?)<\/an>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

function parseRaw(b) {
  const foundAddr = getTag(b, 'FoundAddress');
  const city = getTag(b, 'City');
  const state = getTag(b, 'State');
  return {
    id:            getTag(b, 'ID'),
    name:          getTag(b, 'Name') || 'Unknown',
    breed:         getTag(b, 'PrimaryBreed'),
    breedSec:      getTag(b, 'SecondaryBreed'),
    sex:           getTag(b, 'Sex'),
    ageMonths:     parseInt(getTag(b, 'Age'), 10),
    foundDate:     getTag(b, 'FoundDate'),
    foundAddr,
    city,
    state,
    fullAddr:      [foundAddr, city, state].filter(Boolean).join(', '),
    location:      getTag(b, 'Location'),
    color:         getTag(b, 'PrimaryColor'),
    colorSec:      getTag(b, 'SecondaryColor'),
    jurisdiction:  getTag(b, 'Jurisdiction'),
    spayedNeutered:getTag(b, 'SpayedNeutered'),
    photo:         getTag(b, 'Photo'),
  };
}

function addrKey(r) {
  return `${r.foundDate}|${r.foundAddr.toLowerCase().trim()}|${r.city.toLowerCase().trim()}`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchFoundDetails(id) {
  const url = `${BASE}/foundDetails?animalID=${id}&authkey=${AUTHKEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return getTag(await res.text(), 'Size');
  } catch (e) {
    console.warn(`  foundDetails failed for ${id}: ${e.message}`);
    return '';
  }
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
  let animals = {};
  if (fs.existsSync(ANIMALS_FILE)) {
    try {
      animals = JSON.parse(fs.readFileSync(ANIMALS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(animals).length} existing animals.`);
    } catch { console.warn('Could not parse animals.json — starting fresh.'); }
  }

  let dcCats = {};
  if (fs.existsSync(DC_CATS_FILE)) {
    try {
      dcCats = JSON.parse(fs.readFileSync(DC_CATS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(dcCats).length} existing DC cats.`);
    } catch { console.warn('Could not parse dc-cats.json — starting fresh.'); }
  }

  let coords = {};
  if (fs.existsSync(COORDS_FILE)) {
    try {
      coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(coords).length} existing cached addresses.`);
    } catch { console.warn('Could not parse coords.json — starting fresh.'); }
  }

  console.log('\nFetching all cats from Petango...');
  const url = `${BASE}/foundSearch?speciesID=2&sex=A&ageGroup=All&authkey=${AUTHKEY}&orderBy=DateLast&searchOption=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Petango HTTP ${res.status}`);
  const xml = await res.text();

  const all = splitBlocks(xml).map(parseRaw);
  console.log(`Got ${all.length} total cats.\n`);

  const dcKittens = all.filter(r => r.state === TARGET_STATE && r.ageMonths <= MAX_KITTEN_AGE_MONTHS);
  const adultFemales = all.filter(r => r.sex === 'F' && r.ageMonths > MAX_KITTEN_AGE_MONTHS);
  console.log(`DC kittens: ${dcKittens.length}, adult females: ${adultFemales.length}`);

  const adultByKey = {};
  for (const a of adultFemales) {
    const k = addrKey(a);
    if (!adultByKey[k]) adultByKey[k] = [];
    adultByKey[k].push(a);
  }

  const today = new Date().toISOString().slice(0, 10);
  let newCount = 0, updatedCount = 0, motherMatchCount = 0;

  console.log('\nFetching size details for DC kittens...');
  for (let i = 0; i < dcKittens.length; i++) {
    const r = dcKittens[i];
    const mothers = adultByKey[addrKey(r)] || [];
    const mother = mothers.sort((a, b) => a.ageMonths - b.ageMonths)[0] || null;
    if (mother) motherMatchCount++;

    const possibleMother = mother ? {
      id:        mother.id,
      name:      mother.name,
      breed:     mother.breed,
      color:     mother.color,
      ageMonths: mother.ageMonths,
      sex:       mother.sex,
      location:  mother.location,
      photo:     mother.photo,
      confidence: 'likely',
      note: 'Same-day same-address adult female. Inferred, not confirmed.',
    } : null;

    process.stdout.write(`  [${i + 1}/${dcKittens.length}] ${r.name} ... `);
    const size = await fetchFoundDetails(r.id);
    await sleep(200);
    const noAgeProvided = r.ageMonths === 0;
    console.log(size ? `size: ${size}${noAgeProvided ? ' [no age provided]' : ''}` : 'no size');

    const record = {
      id:             r.id,
      name:           r.name,
      breed:          r.breed,
      breedSec:       r.breedSec,
      sex:            r.sex,
      ageMonths:      r.ageMonths,
      foundDate:      r.foundDate,
      foundAddr:      r.foundAddr,
      city:           r.city,
      state:          r.state,
      fullAddr:       r.fullAddr,
      location:       r.location,
      color:          r.color,
      colorSec:       r.colorSec,
      jurisdiction:   r.jurisdiction,
      spayedNeutered: r.spayedNeutered,
      photo:          r.photo,
      size,
      possibleMother,
      noAgeProvided,
      lastSeenDate:   today,
    };

    if (animals[r.id]) {
      animals[r.id] = { ...record, firstSeenDate: animals[r.id].firstSeenDate };
      updatedCount++;
    } else {
      animals[r.id] = { ...record, firstSeenDate: today };
      newCount++;
    }
  }

  // ── Refresh existing records that are still in Petango but aged out of the kitten filter ──
  const allById = Object.fromEntries(all.map(r => [r.id, r]));
  const processedIds = new Set(dcKittens.map(r => r.id));
  let refreshedCount = 0;

  for (const id of Object.keys(animals)) {
    if (processedIds.has(id) || !allById[id]) continue;
    const fresh = allById[id];
    const size = animals[id].size || '';
    const noAgeProvided = fresh.ageMonths === 0 && (!size || size.toLowerCase() !== 'small');
    animals[id] = {
      ...animals[id],
      ageMonths:      fresh.ageMonths || animals[id].ageMonths,
      location:       fresh.location,
      spayedNeutered: fresh.spayedNeutered,
      photo:          fresh.photo,
      size,
      noAgeProvided,
      lastSeenDate:   today,
    };
    refreshedCount++;
    console.log(`  Refreshed: [${id}] ${animals[id].name} (age now ${fresh.ageMonths}mo)`);
  }

  console.log(`Animals: ${newCount} new, ${updatedCount} updated, ${refreshedCount} refreshed`);
  console.log(`Mother matches: ${motherMatchCount} of ${dcKittens.length} kittens`);
  console.log(`Total in animals.json: ${Object.keys(animals).length}`);

  fs.writeFileSync(ANIMALS_FILE, JSON.stringify(animals, null, 2));
  console.log(`Wrote ${ANIMALS_FILE}\n`);

  // ── Update DC cats log (all DC cats ever seen, regardless of age) ──
  const dcAllCats = all.filter(r => r.state === TARGET_STATE);
  let dcNewCount = 0, dcUpdatedCount = 0;
  for (const r of dcAllCats) {
    if (dcCats[r.id]) {
      dcCats[r.id] = {
        ...dcCats[r.id],
        ageMonths:      r.ageMonths || dcCats[r.id].ageMonths,
        location:       r.location,
        spayedNeutered: r.spayedNeutered,
        photo:          r.photo,
        lastSeenDate:   today,
      };
      dcUpdatedCount++;
    } else {
      dcCats[r.id] = { ...r, firstSeenDate: today, lastSeenDate: today };
      dcNewCount++;
    }
  }
  console.log(`DC cats log: ${dcNewCount} new, ${dcUpdatedCount} updated (${Object.keys(dcCats).length} total)`);
  fs.writeFileSync(DC_CATS_FILE, JSON.stringify(dcCats, null, 2));
  console.log(`Wrote ${DC_CATS_FILE}\n`);

  const addressSet = new Set(Object.values(animals).map(a => a.fullAddr).filter(Boolean));
  const newAddresses = [...addressSet].filter(a => !(a in coords));
  console.log(`${addressSet.size} unique addresses, ${newAddresses.length} not yet geocoded.\n`);

  if (!newAddresses.length) {
    console.log('coords.json already up to date.');
    return;
  }

  let succeeded = 0, failed = 0;
  for (let i = 0; i < newAddresses.length; i++) {
    const address = newAddresses[i];
    process.stdout.write(`[${i + 1}/${newAddresses.length}] ${address} ... `);
    const result = await geocode(address);
    if (result) {
      coords[address] = result;
      succeeded++;
      console.log(`✓ ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`);
    } else {
      coords[address] = null;
      failed++;
      console.log('✗ not found');
    }
    await sleep(100);
  }

  fs.writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2));
  console.log(`\nDone.`);
  console.log(`  Geocoded: ${succeeded} succeeded, ${failed} failed`);
  console.log(`  Total in coords.json: ${Object.keys(coords).length}`);
  console.log(`\nNow commit and push both animals.json and coords.json to your repo.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
