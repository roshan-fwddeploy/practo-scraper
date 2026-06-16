#!/usr/bin/env node
/**
 * Practo doctor scraper + Google Places enrichment.
 *
 * Stage 1 (free):  Scrape Practo search listings -> doctor + clinic + address + map.
 * Stage 2 (free <=1000/mo): Match each UNIQUE clinic on Google Places -> REAL phone,
 *                            website, verified address, clean Maps URL. Optionally
 *                            scrape the clinic website for an email.
 *
 * Why two stages: Practo never exposes a clinic's real phone or email — its
 * "Contact Clinic" number is a virtual/proxy line (vn_phone_number). Google Places
 * is the source of the real contact details, keyed on the name+address Practo gives us.
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx node scrape.js --city bangalore --query "Dentist" --limit 10
 *
 * Flags:
 *   --city     <name>     Practo city slug          (default: bangalore)
 *   --query    <text>     Specialty / issue         (default: Dentist)
 *   --limit    <n>        Max doctors to scrape      (default: 10)
 *   --pages    <n>        Max listing pages to walk  (default: auto from limit)
 *   --no-email            Skip website email scraping (faster)
 *   --headful             Show the browser window (debugging / anti-bot fallback)
 *   --out      <path>     CSV path (default: ~/Downloads/practo_<city>_<query>_<ts>.csv)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  // Headful by default: Practo serves empty results to headless/chrome-headless-shell.
  const a = { city: 'bangalore', query: 'Dentist', limit: 10, pages: 0, email: true, headful: true, useSearch: false, placesApi: false, freeMaps: false, concurrency: 6, fullAddress: false, out: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--city') a.city = argv[++i];
    else if (k === '--query') a.query = argv[++i];
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (k === '--pages') a.pages = parseInt(argv[++i], 10);
    else if (k === '--no-email') a.email = false;
    else if (k === '--headful') a.headful = true;
    else if (k === '--headless') a.headful = false; // opt-in; often blocked by Practo
    else if (k === '--use-search') a.useSearch = true; // robots-disallowed /search path; for free-text issues
    else if (k === '--free-maps') a.freeMaps = true; // force the free Google Maps scrape even if a key is set
    else if (k === '--places-api') a.placesApi = true; // (kept for back-compat; API is auto when key present)
    else if (k === '--concurrency') a.concurrency = Math.max(1, parseInt(argv[++i], 10) || 6);
    else if (k === '--full-address') a.fullAddress = true; // also visit Practo profiles for Practo's own address/coords (slower)
    else if (k === '--out') a.out = argv[++i];
  }
  if (!a.pages) a.pages = Math.max(1, Math.ceil(a.limit / 10)); // Practo shows ~10/page
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min)); // polite, varied delays

// Run `worker` over `items` with at most `n` in flight at once. This is the speed lever:
// N clinics enrich concurrently instead of one-at-a-time.
async function pool(items, n, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// Practo URL builder.
//
// Default = the SEO landing path  /<city>/<specialty>  (e.g. /bangalore/dentist).
// This path is ALLOWED by Practo's robots.txt and returns the same doctor cards.
// The /search?q=... query URL is Disallow'd in robots.txt, so we avoid it unless
// the caller explicitly opts in with --use-search (needed for free-text "issues"
// that don't map to a known specialty slug).
// Both paginate with ?page=N (10 cards/page).
// ---------------------------------------------------------------------------
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildSearchUrl(city, query, page, useSearch) {
  if (useSearch) {
    const q = JSON.stringify([{ word: query, autocompleted: true, category: 'subspeciality' }]);
    const base = `https://www.practo.com/search/doctors?results_type=doctor&q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}`;
    return page > 1 ? `${base}&page=${page}` : base;
  }
  const base = `https://www.practo.com/${slugify(city)}/${slugify(query)}`;
  return page > 1 ? `${base}?page=${page}` : base;
}

// Extract doctor cards from a loaded Practo listing page.
const EXTRACT_CARDS = (nodes) => {
  const txt = (el, id) => { const n = el.querySelector(`[data-qa-id="${id}"]`); return n ? n.innerText.trim() : null; };
  return nodes.map((c) => {
    const link = c.querySelector('a[href*="/doctor/"]');
    const nameEl = c.querySelector('[data-qa-id="doctor_name"]');
    let specialty = null; // the card line right after the doctor name (e.g. "Dentist")
    if (nameEl) {
      const nameText = nameEl.innerText.trim();
      const lines = c.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const idx = lines.indexOf(nameText);
      if (idx >= 0 && lines[idx + 1]) specialty = lines[idx + 1];
    }
    return {
      doctor_name: txt(c, 'doctor_name'),
      specialty,
      experience: txt(c, 'doctor_experience'),
      clinic_name: txt(c, 'doctor_clinic_name'),
      locality: (txt(c, 'practice_locality') || '').replace(/,$/, ''),
      city: txt(c, 'practice_city'),
      consultation_fee: txt(c, 'consultation_fee'),
      recommendation: txt(c, 'doctor_recommendation'),
      profile_url: link ? link.href : null,
    };
  });
};

// ---------------------------------------------------------------------------
// Stage 1: scrape Practo listing pages IN PARALLEL.
// 900 results = 90 pages, so sequential paging is the real bottleneck. We fetch
// pages concurrently (capped low to stay gentle on Cloudflare) and stop a worker
// as soon as it hits an empty page (past the end of results).
// ---------------------------------------------------------------------------
const LISTING_MAX_CONCURRENCY = 6;
async function scrapePracto(context, args) {
  const totalPages = args.pages;
  const workers = Math.min(args.concurrency, LISTING_MAX_CONCURRENCY, totalPages);
  process.stdout.write(`\n[Practo] scraping up to ${totalPages} listing pages (x${workers} parallel) …`);
  const pages = await Promise.all(Array.from({ length: workers }, () => context.newPage()));
  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1);
  const all = [];
  let slot = 0, emptyHits = 0;

  await pool(pageNums, workers, async (p) => {
    if (emptyHits >= 2) return; // results exhausted — let remaining workers wind down
    const page = pages[slot++ % pages.length];
    const url = buildSearchUrl(args.city, args.query, p, args.useSearch);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const ok = await page.waitForSelector('[data-qa-id="doctor_card"]', { timeout: 12000 }).then(() => true).catch(() => false);
      if (!ok) { emptyHits++; return; }
      const cards = await page.$$eval('[data-qa-id="doctor_card"]', EXTRACT_CARDS);
      all.push(...cards);
      process.stdout.write(`\r[Practo] collected ${all.length} cards …            `);
    } catch { /* skip failed page */ }
  });

  await Promise.all(pages.map((p) => p.close()));
  // Dedupe by profile URL (normalize off the ?page_uid noise), cap at limit.
  const seen = new Set(), doctors = [];
  for (const d of all) {
    if (!d.profile_url) continue;
    const key = d.profile_url.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    doctors.push(d);
    if (doctors.length >= args.limit) break;
  }
  process.stdout.write(`\n[Practo] ${doctors.length} unique doctors collected`);
  return doctors;
}

// OPTIONAL: visit Practo profile pages for Practo's own full address + lat/long.
// Off by default — Google Maps already returns a verified address + map link, so this
// is redundant unless you specifically want Practo's address too. Parallelized.
async function addPractoProfiles(context, doctors, concurrency) {
  process.stdout.write(`\n[Practo] fetching ${doctors.length} profiles for Practo address (x${concurrency} parallel) …`);
  const pages = await Promise.all(Array.from({ length: Math.min(concurrency, doctors.length) }, () => context.newPage()));
  let w = 0;
  await pool(doctors, pages.length, async (d) => {
    const page = pages[w++ % pages.length];
    try {
      await page.goto(d.profile_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('[data-qa-id="clinic-address"]', { timeout: 8000 }).catch(() => {});
      const info = await page.evaluate(() => {
        const addr = document.querySelector('[data-qa-id="clinic-address"]');
        const mapA = document.querySelector('a[href*="google.com/maps"], a[href*="maps.google"]');
        return {
          full_address: addr ? addr.innerText.trim().replace(/\s+/g, ' ') : null,
          practo_map_link: mapA ? mapA.href : null,
        };
      });
      Object.assign(d, info);
    } catch { /* leave blank */ }
  });
  await Promise.all(pages.map((p) => p.close()));
  return doctors;
}

// ---------------------------------------------------------------------------
// Clinic de-duplication — collapse many doctors at one clinic into one paid lookup
// ---------------------------------------------------------------------------
function normalizeClinicKey(clinic_name, locality, city) {
  return [clinic_name, locality, city]
    .map((s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .join('|');
}

// Build the Google Places text query for a clinic. Quality of this string drives
// match accuracy — name + locality + city is a strong signal for Indian clinics.
function buildPlacesQuery(d) {
  return [d.clinic_name, d.locality, d.city, 'India'].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------------------
// Stage 2: Google Places (New) enrichment
//   - searchText with FieldMask=places.id  -> FREE (Text Search IDs-only SKU)
//   - place details with phone/website     -> Place Details Enterprise SKU (1000/mo free)
// ---------------------------------------------------------------------------
async function placesTextSearchId(query, apiKey) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id', // IDs-only keeps this call free
    },
    body: JSON.stringify({ textQuery: query, regionCode: 'IN' }),
  });
  if (!res.ok) throw new Error(`TextSearch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.places && j.places[0] ? j.places[0].id : null;
}

async function placesDetails(placeId, apiKey) {
  // Requesting phone/website triggers the Place Details Enterprise SKU (the metered one).
  const fields = 'id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,googleMapsUri,location';
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fields },
  });
  if (!res.ok) throw new Error(`Details ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Best-effort email scrape from the clinic website homepage.
async function scrapeEmail(websiteUri) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(websiteUri, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const clean = [...new Set(matches)].filter(
      (e) => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e) && !/sentry|wixpress|example|sentry\.io|\.wix/i.test(e)
    );
    return clean[0] || null;
  } catch {
    return null;
  }
}

// --- Geo helpers: Practo gives us each clinic's lat/long, which is a far stronger
// match signal than fuzzy names. We use it to disambiguate Google Maps results. ---
function parseLatLng(s) {
  const m = String(s || '').match(/(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
}
function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const COORD_MATCH_METERS = 250; // Google vs Practo geocode of the same place agree within ~tens of m

// --- FREE route: scrape Google Maps directly for the GBP phone/website/address ---
// If the search lands on a results list, opens the result whose coordinates are
// nearest the Practo clinic (not blindly #1). Returns the opened place's coords so
// the caller can verify by distance.
async function scrapeMapsPlace(page, query, targetCoords) {
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1, div[role="feed"]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1400);
  const isList = await page.evaluate(
    () => !!document.querySelector('div[role="feed"] a[href*="/maps/place/"]') && !document.querySelector('button[data-item-id^="phone"]')
  );
  if (isList) {
    // Choose the feed result closest to the Practo coordinates (falls back to #0).
    const idx = await page.evaluate((target) => {
      const at = (u) => { const m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/); return m ? { lat: +m[1], lng: +m[2] } : null; };
      const dist = (a, b) => { if (!a || !b) return Infinity; const R = 6371000, r = (x) => x * Math.PI / 180; const dla = r(b.lat - a.lat), dlo = r(b.lng - a.lng); const s = Math.sin(dla / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dlo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
      const anchors = [...document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]')];
      let best = 0, bestD = Infinity;
      anchors.forEach((a, i) => { const d = target ? dist(target, at(a.href)) : i; if (d < bestD) { bestD = d; best = i; } });
      return best;
    }, targetCoords || null);
    const anchors = await page.$$('div[role="feed"] a[href*="/maps/place/"]');
    if (anchors[idx]) { await anchors[idx].click().catch(() => {}); await page.waitForTimeout(2400); }
  }
  const data = await page.evaluate(() => {
    const get = (sel, attr) => { const e = document.querySelector(sel); return e ? (attr ? e.getAttribute(attr) : e.innerText) : null; };
    const phoneId = get('button[data-item-id^="phone"]', 'data-item-id'); // "phone:tel:0XXXXXXXXXX"
    const addr = get('button[data-item-id="address"]', 'aria-label');
    const title = get('h1');
    return {
      title: title && title !== 'Results' ? title.trim() : null,
      phone: phoneId ? phoneId.replace('phone:tel:', '').trim() : null,
      website: get('a[data-item-id="authority"]', 'href'),
      address: addr ? addr.replace(/^Address:\s*/i, '').trim() : null,
      maps_url: location.href.split('?')[0],
    };
  });
  // The !3d<lat>!4d<lng> data params are the place's ACTUAL pin (the @lat,lng is just
  // the map viewport center, which can be offset). Prefer the pin; fall back to viewport.
  const pin = data.maps_url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  data.coords = pin
    ? { lat: parseFloat(pin[1]), lng: parseFloat(pin[2]) }
    : parseLatLng((data.maps_url.match(/@(-?\d+\.\d+,-?\d+\.\d+)/) || [])[1]);
  return data;
}

// ---------------------------------------------------------------------------
// Match-verification guard (free route only).
// The free Maps scrape can surface the WRONG business when the name is ambiguous,
// so we only trust a result when Google's returned address contains the Practo
// locality AND the names share real tokens. No confident match => leave blank
// (a blank you re-check beats a wrong number you trust — per the no-hallucination rule).
// Tune THRESH / the rule here if you want it looser or stricter.
// ---------------------------------------------------------------------------
const NAME_MATCH_THRESHOLD = 0.34;
function toTokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2));
}
function verifyMapsMatch(clinic, result) {
  if (!result || !result.title || !result.phone) return false;
  // PRIMARY signal: coordinates. If Google's place sits within ~250m of Practo's
  // pin for this clinic, it's the same physical place — trust it regardless of name.
  const target = parseLatLng(clinic.practo_map_link);
  if (target && result.coords && haversineMeters(target, result.coords) <= COORD_MATCH_METERS) return true;
  // FALLBACK (no coords available): locality must appear in the address AND names overlap.
  const nameTok = toTokens(clinic.clinic_name);
  const titleTok = toTokens(result.title);
  let overlap = 0;
  for (const t of nameTok) if (titleTok.has(t)) overlap++;
  const nameScore = nameTok.size ? overlap / nameTok.size : 0;
  const locTok = toTokens(clinic.locality);
  const addrTok = toTokens(result.address);
  let locHit = 0;
  for (const t of locTok) if (addrTok.has(t)) locHit++;
  const localityInAddress = locTok.size ? locHit / locTok.size >= 0.5 : false;
  return localityInAddress && nameScore >= NAME_MATCH_THRESHOLD;
}

function groupByClinic(doctors) {
  const groups = new Map();
  for (const d of doctors) {
    const key = normalizeClinicKey(d.clinic_name, d.locality, d.city);
    if (!groups.has(key)) groups.set(key, { sample: d, members: [] });
    groups.get(key).members.push(d);
  }
  return groups;
}

const EMPTY_ENRICH = { real_phone: null, website: null, email: null, google_address: null, google_maps_url: null, match_source: '', matched: false };

// FREE enrichment — scrape Google Maps with the verification guard, N clinics in parallel.
async function enrichViaMaps(context, doctors, wantEmail, concurrency) {
  const groups = [...groupByClinic(doctors).values()];
  const n = Math.min(concurrency, groups.length);
  process.stdout.write(`\n[Maps] ${doctors.length} doctors -> ${groups.length} unique clinics (FREE, x${n} parallel)`);
  const pages = await Promise.all(Array.from({ length: n }, () => context.newPage()));
  let matched = 0, rejected = 0, slot = 0;

  await pool(groups, n, async (g) => {
    const page = pages[slot++ % pages.length];
    const d = g.sample;
    const e = { ...EMPTY_ENRICH };
    const target = parseLatLng(d.practo_map_link);
    try {
      let r = null, ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        r = await scrapeMapsPlace(page, buildPlacesQuery(d), target);
        ok = verifyMapsMatch(d, r);
        if (!ok && attempt === 1) await sleep(jitter(1500, 2500)); // brief back-off, retry once
      }
      if (ok) {
        e.real_phone = r.phone; e.website = r.website; e.google_address = r.address;
        e.google_maps_url = r.maps_url; e.match_source = 'google_maps'; e.matched = true;
        matched++;
        if (wantEmail && r.website) e.email = await scrapeEmail(r.website);
        process.stdout.write(`\n[Maps] ✓ ${d.clinic_name} -> ${r.phone}`);
      } else {
        e.match_source = 'unverified';
        rejected++;
        process.stdout.write(`\n[Maps] · ${d.clinic_name} -> no confident match (blank)`);
      }
    } catch (err) {
      process.stdout.write(`\n[Maps] ! ${d.clinic_name} -> ${err.message}`);
    }
    for (const m of g.members) Object.assign(m, e);
  });

  await Promise.all(pages.map((p) => p.close()));
  process.stdout.write(`\n[Maps] matched ${matched}, blank ${rejected}. Cost: $0\n`);
  return doctors;
}

// PAID enrichment — Google Places API (opt-in via --places-api). HTTP, fully parallel.
async function enrichViaPlacesApi(doctors, apiKey, wantEmail, concurrency) {
  const groups = [...groupByClinic(doctors).values()];
  process.stdout.write(`\n[Places API] ${doctors.length} doctors -> ${groups.length} unique clinics (x${concurrency} parallel)`);
  let lookups = 0;
  await pool(groups, concurrency, async (g) => {
    const d = g.sample;
    const e = { ...EMPTY_ENRICH };
    try {
      const placeId = await placesTextSearchId(buildPlacesQuery(d), apiKey); // FREE
      if (placeId) {
        const det = await placesDetails(placeId, apiKey); // metered (Enterprise)
        lookups++;
        e.real_phone = det.nationalPhoneNumber || det.internationalPhoneNumber || null;
        e.website = det.websiteUri || null;
        e.google_address = det.formattedAddress || null;
        e.google_maps_url = det.googleMapsUri || null;
        e.match_source = 'places_api'; e.matched = true;
        if (wantEmail && det.websiteUri) e.email = await scrapeEmail(det.websiteUri);
      }
      process.stdout.write(`\n[Places API] ${d.clinic_name} -> ${e.real_phone || 'no match'}`);
    } catch (err) {
      process.stdout.write(`\n[Places API] ${d.clinic_name} -> ERROR ${err.message}`);
    }
    for (const m of g.members) Object.assign(m, e);
  });
  process.stdout.write(`\n[Places API] billed Place Details lookups: ${lookups} (free up to 1000/month)\n`);
  return doctors;
}

// ---------------------------------------------------------------------------
// CSV output
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  ['doctor_name', 'Doctor Name'],
  ['clinic_name', 'Hospital / Clinic'],
  ['specialty', 'Specialty'],
  ['experience', 'Experience'],
  ['real_phone', 'Phone (Google, real)'],
  ['email', 'Email'],
  ['google_address', 'Address (Google, verified)'],
  ['full_address', 'Address (Practo)'],
  ['locality', 'Locality'],
  ['city', 'City'],
  ['google_maps_url', 'Map Link (Google)'],
  ['practo_map_link', 'Map Link (Practo)'],
  ['website', 'Website'],
  ['consultation_fee', 'Consultation Fee'],
  ['recommendation', 'Recommendation %'],
  ['match_source', 'Phone Source'],
  ['profile_url', 'Practo Profile'],
];

function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = CSV_COLUMNS.map(([, label]) => esc(label)).join(',');
  const body = rows.map((r) => CSV_COLUMNS.map(([key]) => esc(r[key])).join(',')).join('\n');
  return header + '\n' + body + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
  const useApi = !!apiKey && !args.freeMaps; // key present => use the API (fast, scales); --free-maps overrides
  console.log(`Phone enrichment: ${useApi ? 'Google Places API (first 1000/month free)' : 'FREE Google Maps scrape (with match guard)'}`);
  if (!apiKey && !args.freeMaps) {
    console.log('  (no GOOGLE_MAPS_API_KEY found — using the free Maps scrape. Set the key for fast, at-scale runs.)');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = args.out ||
    path.join(os.homedir(), 'Downloads', `practo_${args.city}_${args.query.replace(/\s+/g, '-')}_${ts}.csv`);

  console.log(`Practo scraper → city="${args.city}" query="${args.query}" limit=${args.limit}`);

  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
  });
  // Speed: don't download images / map tiles / fonts / media — we only read the DOM.
  // Cuts Google Maps and Practo page-load time roughly in half.
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  const t0 = Date.now();
  let doctors = [];
  try {
    doctors = await scrapePracto(context, args); // listing only — fast
    if (doctors.length === 0) {
      console.log('\nNo doctors scraped. If you used --headless, drop it (Practo blocks headless); otherwise check the city/query.');
      await context.close(); await browser.close();
      process.exit(1);
    }
    if (args.fullAddress) await addPractoProfiles(context, doctors, args.concurrency); // optional, slower
    // Stage 2 — enrich (parallel). Google Maps supplies the address + map link too.
    if (useApi) await enrichViaPlacesApi(doctors, apiKey, args.email, args.concurrency);
    else await enrichViaMaps(context, doctors, args.email, args.concurrency);
  } finally {
    await context.close();
    await browser.close();
  }
  const secs = Math.round((Date.now() - t0) / 1000);

  fs.writeFileSync(outPath, toCsv(doctors));
  const withPhone = doctors.filter((d) => d.real_phone).length;
  const withEmail = doctors.filter((d) => d.email).length;
  console.log(`\n✅ Done in ${secs}s. ${doctors.length} doctors | ${withPhone} real phones | ${withEmail} emails`);
  console.log(`📄 CSV: ${outPath}\n`);
})();
