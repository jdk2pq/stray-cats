// .github/scripts/update-coords.js
// Nightly GitHub Action script:
//   1. Fetches ALL cats from Petango (kittens + adults, DC only)
//   2. Merges DC kittens into animals.json — adds new, never deletes old
//   3. For each kitten, checks if a same-date same-address adult female exists
//      and annotates with possibleMother (inferred, not confirmed)
//   4. Geocodes new addresses via Nominatim → updates coords.json
//   5. Commits both files if changed
//
// Nominatim acceptable use compliance:
//   ✓ Max 1 request per second (enforced via 1100ms sleep)
//   ✓ Custom User-Agent identifying this application
//   ✓ Results fully cached — same address is never requested twice
//   ✓ Single thread, single machine (GitHub Actions runner)
//   ✓ Only geocodes new trickle addresses (typically 1-5/day after initial seed)
//   ✓ Refuses to run if too many new addresses — use seed-coords.js instead
//
// Attribution: OSM/Nominatim attribution is displayed in the map UI (index.html).

import fs from 'fs';

const AUTHKEY = '5e2qhdg1s6kqsdf8s3asnwo3ttgyxai0slvr17vdj7oq5qoiwx';
const BASE = 'https://ws.petango.com/webservices/wsAdoption.asmx';
const ANIMALS_FILE = 'animals.json';
const COORDS_FILE = 'coords.json';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'dc-kitten-finder/1.0 (github-actions nightly update; geocodes new kitten addresses only)';
const MAX_NEW_ADDRESSES = 20;

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

async function geocode(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://github.com' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch (e) {
    console.warn(`  Geocode failed for "${address}": ${e.message}`);
  }
  return null;
}

async function main() {
  // ── Load existing animals ──
  let animals = {};
  if (fs.existsSync(ANIMALS_FILE)) {
    try {
      animals = JSON.parse(fs.readFileSync(ANIMALS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(animals).length} existing animals from ${ANIMALS_FILE}`);
    } catch { console.warn('Could not parse animals.json — starting fresh.'); }
  } else {
    console.log('No existing animals.json — will create one.');
  }

  // ── Load existing coords ──
  let coords = {};
  if (fs.existsSync(COORDS_FILE)) {
    try {
      coords = JSON.parse(fs.readFileSync(COORDS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(coords).length} cached addresses from ${COORDS_FILE}`);
    } catch { console.warn('Could not parse coords.json — starting fresh.'); }
  }

  // ── Fetch ALL cats from Petango (need adults too for mother matching) ──
  console.log('\nFetching all cats from Petango...');
  const url = `${BASE}/foundSearch?speciesID=2&sex=A&ageGroup=All&authkey=${AUTHKEY}&orderBy=DateLast&searchOption=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Petango returned HTTP ${res.status}`);
  const xml = await res.text();

  const all = splitBlocks(xml).map(parseRaw);
  console.log(`Got ${all.length} total cats from Petango.`);

  const dcKittens = all.filter(r => r.state === TARGET_STATE && r.ageMonths <= MAX_KITTEN_AGE_MONTHS);
  const adultFemales = all.filter(r => r.sex === 'F' && r.ageMonths > MAX_KITTEN_AGE_MONTHS);

  console.log(`DC kittens: ${dcKittens.length}, adult females in dataset: ${adultFemales.length}`);

  // Build lookup: addrKey → adult female record
  const adultByKey = {};
  for (const a of adultFemales) {
    const k = addrKey(a);
    if (!adultByKey[k]) adultByKey[k] = [];
    adultByKey[k].push(a);
  }

  // ── Merge DC kittens into animals, annotate with possibleMother ──
  const today = new Date().toISOString().slice(0, 10);
  let newCount = 0, updatedCount = 0, motherMatchCount = 0;

  for (const r of dcKittens) {
    const mothers = adultByKey[addrKey(r)] || [];
    // Pick the best candidate: prefer female, youngest adult (most likely to be nursing)
    const mother = mothers.sort((a, b) => a.ageMonths - b.ageMonths)[0] || null;

    const possibleMother = mother ? {
      id:        mother.id,
      name:      mother.name,
      breed:     mother.breed,
      color:     mother.color,
      ageMonths: mother.ageMonths,
      sex:       mother.sex,
      location:  mother.location,
      photo:     mother.photo,
      // Note confidence — all matched adults in this dataset have been female,
      // same-day same-address is a strong signal for TNR trap scenarios
      confidence: 'likely',
      note: 'Same-day same-address adult female. Inferred, not confirmed.',
    } : null;

    if (mother) motherMatchCount++;

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
      possibleMother,
      lastSeenDate:   today,
    };

    if (animals[r.id]) {
      animals[r.id] = {
        ...record,
        firstSeenDate: animals[r.id].firstSeenDate,
      };
      updatedCount++;
    } else {
      animals[r.id] = { ...record, firstSeenDate: today };
      newCount++;
      console.log(`  New kitten: [${r.id}] ${r.name}${mother ? ` (mother: ${mother.name})` : ''}`);
    }
  }

  console.log(`\nAnimals: ${newCount} new, ${updatedCount} updated`);
  console.log(`Mother matches: ${motherMatchCount} of ${dcKittens.length} kittens`);
  console.log(`Total in animals.json: ${Object.keys(animals).length}`);

  fs.writeFileSync(ANIMALS_FILE, JSON.stringify(animals, null, 2));
  console.log(`Wrote ${ANIMALS_FILE}`);

  // ── Geocode new addresses ──
  const addressSet = new Set(Object.values(animals).map(a => a.fullAddr).filter(Boolean));
  const newAddresses = [...addressSet].filter(a => !(a in coords));
  console.log(`\n${newAddresses.length} new address(es) to geocode.`);

  if (newAddresses.length > MAX_NEW_ADDRESSES) {
    console.error(
      `\nError: ${newAddresses.length} new addresses — exceeds safe limit of ${MAX_NEW_ADDRESSES}.` +
      `\nRun seed-coords.js locally (Google Geocoding API) to bulk-populate coords.json first.`
    );
    process.exit(1);
  }

  let succeeded = 0, failed = 0;
  for (const address of newAddresses) {
    console.log(`  Geocoding: ${address}`);
    const result = await geocode(address);
    if (result) {
      coords[address] = result;
      succeeded++;
      console.log(`    → ${result.lat}, ${result.lng}`);
    } else {
      coords[address] = null;
      failed++;
      console.log(`    → not found (cached as null)`);
    }
    await sleep(1100);
  }

  fs.writeFileSync(COORDS_FILE, JSON.stringify(coords, null, 2));
  console.log(`\nDone.`);
  console.log(`  coords.json: ${Object.keys(coords).length} total, ${succeeded} newly geocoded, ${failed} failed`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
