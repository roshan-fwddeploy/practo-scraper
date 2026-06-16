#!/usr/bin/env python3
"""
Practo doctor scraper — 100% FREE, headless, no API keys.

Powered by Scrapling's StealthyFetcher (Camoufox), which scrapes Practo *headless*
(plain Playwright gets served empty pages) and pulls real clinic phone numbers off
Google Maps without the paid Places API.

Pipeline (all async / concurrent):
  1. Practo listing pages  -> doctor + clinic + locality            (robots-allowed SEO path)
  2. Practo profile pages  -> full address + lat/long pin            (gives a reliable match anchor)
  3. Google Maps per clinic-> REAL phone, website, verified address  (FREE; verified by distance)
  4. Clinic website        -> email (best effort)
  -> CSV in ~/Downloads/

Real phone + email do NOT exist on Practo (it only exposes a virtual/proxy number),
so they come from Google Maps / the clinic's own site.

Usage:
  python scrape.py --city bangalore --query "Dentist" --limit 10
  python scrape.py --city mumbai --query "Dermatologist" --limit 300 --concurrency 8
  python scrape.py ... --fast          # skip Practo profiles (faster, name/locality guard)
  python scrape.py ... --proxy http://user:pass@host:port   # for large scale
"""
import argparse
import asyncio
import csv
import math
import os
import re
import sys
from datetime import datetime
from urllib.parse import quote

from scrapling.fetchers import StealthyFetcher, AsyncFetcher, Fetcher

# --------------------------------------------------------------------------- #
# URL helpers
# --------------------------------------------------------------------------- #
def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower().strip()).strip("-")

def listing_url(city: str, query: str, page: int, use_search: bool) -> str:
    if use_search:  # robots-disallowed; only for free-text issues that lack a specialty page
        import json
        q = quote(json.dumps([{"word": query, "autocompleted": True, "category": "subspeciality"}]))
        base = f"https://www.practo.com/search/doctors?results_type=doctor&q={q}&city={quote(city)}"
        return f"{base}&page={page}" if page > 1 else base
    base = f"https://www.practo.com/{slugify(city)}/{slugify(query)}"
    return f"{base}?page={page}" if page > 1 else base

def paginate_url(url: str, page: int) -> str:
    """Add &page=N to any pasted Practo URL, preserving its filters."""
    url = re.sub(r"([?&])page=\d+", r"\1", url).rstrip("?&")
    if page <= 1:
        return url
    return f"{url}{'&' if '?' in url else '?'}page={page}"

def url_meta(url: str):
    """Best-effort (city, specialty) from a pasted Practo URL, for labels + CSV naming."""
    m = re.search(r"practo\.com/([^/?#]+)/([^/?#]+)", url)
    if m and m.group(1) != "search":
        return m.group(1), m.group(2).replace("-", " ")
    city = (re.search(r"[?&]city=([^&]+)", url) or [None, "results"])[1]
    qm = re.search(r'"word"[%:]*"?([A-Za-z ]+)', url.replace("%22", '"').replace("%3A", ":"))
    return city, (qm.group(1).strip() if qm else "doctors")

# --------------------------------------------------------------------------- #
# Geo helpers — coordinates are a far stronger match signal than fuzzy names
# --------------------------------------------------------------------------- #
def parse_latlng(s):
    m = re.search(r"(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})", s or "")
    return (float(m.group(1)), float(m.group(2))) if m else None

def parse_pin(url):
    """Google's real place pin lives in !3d<lat>!4d<lng> (the @lat,lng is viewport center)."""
    m = re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", url or "")
    if m:
        return (float(m.group(1)), float(m.group(2)))
    m2 = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url or "")
    return (float(m2.group(1)), float(m2.group(2))) if m2 else None

def haversine_m(a, b):
    if not a or not b:
        return float("inf")
    R = 6371000
    dlat, dlng = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

COORD_MATCH_M = 300

# --------------------------------------------------------------------------- #
# Scrapling fetch wrappers
# --------------------------------------------------------------------------- #
# Practo pages are server-rendered -> pure async HTTP, no browser (fast, high concurrency).
async def http_get(url, sem, proxy=None):
    async with sem:
        try:
            return await AsyncFetcher.get(url, stealthy_headers=True, timeout=30, proxy=proxy)
        except Exception as e:
            sys.stderr.write(f"\n  http error {url[:60]}: {e}")
            return None

# Google Maps needs a real (stealth) browser because the phone loads via JS.
# `idle=True` is robust for the search page (place OR results feed); the faster
# wait_selector path is used only when fetching a specific place URL.
async def maps_fetch(url, sem, proxy=None, wait_phone=False):
    async with sem:
        try:
            kw = dict(headless=True, timeout=45000, proxy=proxy)
            if wait_phone:
                kw.update(network_idle=False, wait_selector='button[data-item-id^="phone"]')
            else:
                kw.update(network_idle=True)
            return await StealthyFetcher.async_fetch(url, **kw)
        except Exception as e:
            sys.stderr.write(f"\n  maps error {url[:60]}: {e}")
            return None

def first_text(el, css):
    r = el.css(css + "::text")
    return r.get().strip() if r and r.get() else None

def attr(el, css, name):
    r = el.css(css)
    return r[0].attrib.get(name) if r else None

# --------------------------------------------------------------------------- #
# Stage 1 — Practo listing
# --------------------------------------------------------------------------- #
def parse_cards(resp, query):
    out = []
    for c in resp.css('[data-qa-id="doctor_card"]'):
        def g(qa):
            r = c.css(f'[data-qa-id="{qa}"]::text')
            return r.get().strip() if r and r.get() else None
        link = c.css('a[href*="/doctor/"]')
        href = link[0].attrib.get("href") if link else None
        if href and href.startswith("/"):
            href = "https://www.practo.com" + href  # Scrapling returns raw (relative) hrefs
        out.append({
            "doctor_name": g("doctor_name"),
            "specialty": query,
            "experience": g("doctor_experience"),
            "clinic_name": g("doctor_clinic_name"),
            "locality": (g("practice_locality") or "").rstrip(","),
            "city": g("practice_city"),
            "consultation_fee": g("consultation_fee"),
            "recommendation": g("doctor_recommendation"),
            "profile_url": href,
            "full_address": None, "practo_pin": None,
            "real_phone": None, "email": None, "website": None,
            "google_address": None, "google_maps_url": None, "match_source": "",
        })
    return out

async def scrape_listing(args, http_sem):
    pages = args.pages or max(1, math.ceil(args.limit / 10))
    print(f"[Practo] scraping up to {pages} listing pages (HTTP, concurrency {args.concurrency}) …")
    def url_for(p):
        raw = getattr(args, "url", None)
        return paginate_url(raw, p) if raw else listing_url(args.city, args.query, p, args.use_search)
    tasks = [http_get(url_for(p), http_sem, args.proxy) for p in range(1, pages + 1)]
    doctors, seen = [], set()
    for resp in await asyncio.gather(*tasks):
        if not resp:
            continue
        for d in parse_cards(resp, args.query):
            key = (d["profile_url"] or "").split("?")[0]
            if not key or key in seen:
                continue
            seen.add(key)
            doctors.append(d)
            if len(doctors) >= args.limit:
                break
    print(f"[Practo] {len(doctors)} unique doctors")
    return doctors[: args.limit]

# --------------------------------------------------------------------------- #
# Stage 2 — Practo profiles (full address + pin) — skipped with --fast
# --------------------------------------------------------------------------- #
async def add_profiles(doctors, http_sem, proxy):
    print(f"[Practo] fetching {len(doctors)} profiles for address + coordinates (HTTP) …")
    async def one(d):
        resp = await http_get(d["profile_url"], http_sem, proxy)
        if not resp:
            return
        addr = resp.css('[data-qa-id="clinic-address"]::text')
        d["full_address"] = re.sub(r"\s+", " ", addr.get()).strip() if addr and addr.get() else None
        mapa = resp.css('a[href*="google.com/maps"], a[href*="maps.google"]')
        if mapa:
            d["practo_pin"] = parse_latlng(mapa[0].attrib.get("href"))
    await asyncio.gather(*[one(d) for d in doctors])

# --------------------------------------------------------------------------- #
# Stage 3 — Google Maps enrichment (FREE) with verification guard
# --------------------------------------------------------------------------- #
def norm_tokens(s):
    return {w for w in re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split() if len(w) > 2}

def verify(clinic, res):
    if not res or not res.get("title") or not res.get("phone"):
        return False
    # PRIMARY: coordinate distance (only available when profiles were fetched)
    if clinic.get("practo_pin") and res.get("coords"):
        return haversine_m(clinic["practo_pin"], res["coords"]) <= COORD_MATCH_M
    # FALLBACK: locality must appear in the returned address AND names overlap
    name = norm_tokens(clinic["clinic_name"]); title = norm_tokens(res["title"])
    name_score = (len(name & title) / len(name)) if name else 0
    loc = norm_tokens(clinic["locality"]); adr = norm_tokens(res["address"])
    loc_ok = (len(loc & adr) / len(loc) >= 0.5) if loc else False
    return loc_ok and name_score >= 0.34

def extract_place(resp):
    pid = attr(resp, 'button[data-item-id^="phone"]', "data-item-id")
    addr = attr(resp, 'button[data-item-id="address"]', "aria-label")
    title = first_text(resp, "h1")
    return {
        "title": title if title and title != "Results" else None,
        "phone": pid.replace("phone:tel:", "").strip() if pid else None,
        "website": attr(resp, 'a[data-item-id="authority"]', "href"),
        "address": re.sub(r"^Address:\s*", "", addr).strip() if addr else None,
        "maps_url": (resp.url or "").split("?")[0],
        "coords": parse_pin(resp.url or ""),
    }

async def maps_lookup(clinic, sem, proxy):
    q = ", ".join(filter(None, [clinic["clinic_name"], clinic["locality"], clinic["city"], "India"]))
    resp = await maps_fetch(f"https://www.google.com/maps/search/{quote(q)}", sem, proxy)
    if not resp:
        return None
    # If it resolved straight to a place, we're done.
    if resp.css('button[data-item-id^="phone"]'):
        return extract_place(resp)
    # Otherwise it's a results feed — pick the result nearest the Practo pin and fetch it.
    feed = resp.css('div[role="feed"] a[href*="/maps/place/"]')
    if not feed:
        return None
    target = clinic.get("practo_pin")
    best = feed[0].attrib.get("href")
    if target:
        best_d = float("inf")
        for a in feed[:6]:
            href = a.attrib.get("href", "")
            d = haversine_m(target, parse_pin(href))
            if d < best_d:
                best_d, best = d, href
    if best and best.startswith("/"):
        best = "https://www.google.com" + best
    resp2 = await maps_fetch(best, sem, proxy, wait_phone=True)  # a place URL -> wait for phone, faster
    return extract_place(resp2) if resp2 else None

async def enrich(doctors, sem, proxy, want_email):
    # Group by unique clinic so each real clinic is looked up once.
    groups = {}
    for d in doctors:
        key = (slugify(d["clinic_name"]), slugify(d["locality"]))
        groups.setdefault(key, []).append(d)
    print(f"[Maps] {len(doctors)} doctors -> {len(groups)} unique clinics (FREE Google Maps)")
    matched = 0

    async def one(members):
        nonlocal matched
        d = members[0]
        res = await maps_lookup(d, sem, proxy)
        enr = {}
        if verify(d, res):
            enr = {"real_phone": res["phone"], "website": res["website"],
                   "google_address": res["address"], "google_maps_url": res["maps_url"],
                   "match_source": "google_maps"}
            matched += 1
            if want_email and res["website"]:
                enr["email"] = scrape_email(res["website"])
            print(f"  ✓ {d['clinic_name']} -> {res['phone']}")
        else:
            enr = {"match_source": "unverified"}
            print(f"  · {d['clinic_name']} -> no confident match (blank)")
        for m in members:
            m.update(enr)

    await asyncio.gather(*[one(v) for v in groups.values()])
    print(f"[Maps] matched {matched}/{len(groups)} clinics. Cost: $0")

# --------------------------------------------------------------------------- #
# Stage 4 — email from clinic website (best effort, free)
# --------------------------------------------------------------------------- #
def scrape_email(url):
    try:
        page = Fetcher.get(url, timeout=10, stealthy_headers=True)
        emails = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", page.html_content or "")
        for e in dict.fromkeys(emails):
            if not re.search(r"\.(png|jpe?g|gif|svg|webp)$|sentry|wixpress|example|practo\.|godaddy|wordpress|\.wix", e, re.I):
                return e
    except Exception:
        pass
    return None

# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
COLUMNS = [
    ("doctor_name", "Doctor Name"), ("clinic_name", "Hospital / Clinic"), ("specialty", "Specialty"),
    ("experience", "Experience"), ("real_phone", "Phone (real)"), ("email", "Email"),
    ("google_address", "Address (Google)"), ("full_address", "Address (Practo)"),
    ("locality", "Locality"), ("city", "City"), ("google_maps_url", "Map Link"),
    ("website", "Website"), ("consultation_fee", "Fee"), ("recommendation", "Recommendation %"),
    ("match_source", "Phone Source"), ("profile_url", "Practo Profile"),
]

def write_csv(doctors, path):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([label for _, label in COLUMNS])
        for d in doctors:
            w.writerow([d.get(k, "") or "" for k, _ in COLUMNS])

# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="bangalore")
    ap.add_argument("--query", default="Dentist")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--pages", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=20, help="HTTP concurrency for Practo (cheap)")
    ap.add_argument("--browser-concurrency", type=int, default=8, help="stealth-browser concurrency for Google Maps")
    ap.add_argument("--fast", action="store_true", help="skip Practo profiles (faster, less precise guard)")
    ap.add_argument("--no-email", dest="email", action="store_false")
    ap.add_argument("--use-search", action="store_true", help="robots-disallowed /search path (free-text issues)")
    ap.add_argument("--proxy", default=None)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    http_sem = asyncio.Semaphore(args.concurrency)          # cheap HTTP (Practo)
    browser_sem = asyncio.Semaphore(args.browser_concurrency)  # heavy stealth browser (Maps)
    t0 = datetime.now()
    print(f"FREE Scrapling scraper → city={args.city} query={args.query} limit={args.limit}")

    doctors = await scrape_listing(args, http_sem)
    if not doctors:
        print("No doctors found. Check the city/query, or try --use-search.")
        return
    if not args.fast:
        await add_profiles(doctors, http_sem, args.proxy)
    await enrich(doctors, browser_sem, args.proxy, args.email)

    ts = t0.strftime("%Y-%m-%dT%H-%M-%S")
    out = args.out or os.path.join(os.path.expanduser("~/Downloads"),
                                   f"practo_{slugify(args.city)}_{slugify(args.query)}_{ts}.csv")
    write_csv(doctors, out)
    secs = int((datetime.now() - t0).total_seconds())
    ph = sum(1 for d in doctors if d["real_phone"]); em = sum(1 for d in doctors if d["email"])
    print(f"\n✅ Done in {secs}s. {len(doctors)} doctors | {ph} real phones | {em} emails | $0")
    print(f"📄 CSV: {out}")

if __name__ == "__main__":
    asyncio.run(main())
