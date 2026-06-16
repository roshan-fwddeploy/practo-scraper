#!/usr/bin/env python3
"""
Local web UI for the free Practo scraper.

Run:  python server.py          (or: uvicorn server:app --port 8765)
Open: http://127.0.0.1:8765

- /api/count   : fast — fetches page 1, returns total results + time estimate
- /api/scrape  : SSE stream — scrapes a slice [offset, offset+limit) and streams leads live
- /api/download: serves the session CSV

The full Practo listing+profiles is scraped once per (city, query) and cached, so
"batch" runs just enrich the next slice of clinics via Google Maps.
"""
import asyncio
import json
import math
import os
import re
import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse

import scrape  # reuse the scraping building blocks

app = FastAPI()
HERE = os.path.dirname(os.path.abspath(__file__))
DOWNLOADS = os.path.expanduser("~/Downloads")

# Per-(city,query) session cache: full doctor list + a stable CSV path.
CACHE: dict = {}
SAFETY_PAGE_CAP = 200  # never fetch more than this many listing pages

# Measured throughput for the estimate (free Google Maps stealth fetch).
SECS_PER_CLINIC = 5.0
BROWSER_CONCURRENCY = 8
HTTP_CONCURRENCY = 20
UNIQUE_RATIO = 0.85  # doctors -> unique clinics (many share a clinic)


def sse(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def args_for(city, query, use_search, limit=5000, url=None):
    return SimpleNamespace(city=city, query=query, limit=limit, pages=0,
                           concurrency=HTTP_CONCURRENCY, browser_concurrency=BROWSER_CONCURRENCY,
                           fast=False, email=True, use_search=use_search, proxy=None, url=url)


def parse_total(resp, query):
    """Pull Practo's '784 Dentists' style total from the listing page."""
    html = resp.html_content or ""
    head = re.escape(query.split()[0])
    m = re.search(rf"([\d,]{{2,}})\s+{head}", html, re.I)
    return int(m.group(1).replace(",", "")) if m else None


def estimate_seconds(unique):
    base = unique * SECS_PER_CLINIC / BROWSER_CONCURRENCY
    return int(base), int(base * 1.7)


async def ensure_listing(city, query, use_search, url=None):
    """Scrape the full Practo listing + profiles once; cache it."""
    key = url or (city, query, use_search)
    if key in CACHE:
        return CACHE[key]
    http_sem = asyncio.Semaphore(HTTP_CONCURRENCY)
    if url:
        city, query = scrape.url_meta(url)
    args = args_for(city, query, use_search, url=url)

    if url:
        p1 = await scrape.http_get(scrape.paginate_url(url, 1), http_sem)
    else:
        # page 1 -> total (auto-fallback to Practo search)
        p1, use_search = await fetch_page1(city, query, use_search, http_sem)
        args.use_search = use_search
    total = parse_total(p1, query) if p1 else None
    args.pages = min(SAFETY_PAGE_CAP, math.ceil(total / 10)) if total else 30

    doctors = await scrape.scrape_listing(args, http_sem)
    # Profiles (for address + map pin) are fetched lazily per slice, not all upfront.
    for i, d in enumerate(doctors):
        d["id"] = i
        d["clinic_key"] = scrape.slugify(d["clinic_name"]) + "|" + scrape.slugify(d["locality"])
    ts = time.strftime("%Y-%m-%dT%H-%M-%S")
    csv_path = os.path.join(DOWNLOADS, f"practo_{scrape.slugify(city)}_{scrape.slugify(query)}_{ts}.csv")
    CACHE[key] = {"doctors": doctors, "csv": csv_path,
                  "reported_total": total or len(doctors)}
    return CACHE[key]


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(HERE, "index.html"), encoding="utf-8") as f:
        return f.read()


async def fetch_page1(city, query, use_search, http_sem):
    """Try the specialty path; auto-fall back to Practo's search engine for any term."""
    p1 = await scrape.http_get(scrape.listing_url(city, query, 1, use_search), http_sem)
    if (not p1 or not p1.css('[data-qa-id="doctor_card"]')) and not use_search:
        p2 = await scrape.http_get(scrape.listing_url(city, query, 1, True), http_sem)
        if p2 and p2.css('[data-qa-id="doctor_card"]'):
            return p2, True
    return p1, use_search


@app.get("/api/count")
async def api_count(city: str = "bangalore", query: str = "Dentist",
                    use_search: bool = False, url: str = ""):
    """Fast pre-flight: total results + time estimate (page-1 only)."""
    http_sem = asyncio.Semaphore(HTTP_CONCURRENCY)
    if url:
        if "practo.com" not in url:
            return {"ok": False, "msg": "Please paste a practo.com search/listing URL."}
        city, query = scrape.url_meta(url)
        p1 = await scrape.http_get(scrape.paginate_url(url, 1), http_sem)
    else:
        p1, use_search = await fetch_page1(city, query, use_search, http_sem)
    if not p1 or not p1.css('[data-qa-id="doctor_card"]'):
        return {"ok": False, "msg": "No results — check the link, city, or clinic type."}
    total = parse_total(p1, query) or len(p1.css('[data-qa-id="doctor_card"]'))
    unique = max(1, int(total * UNIQUE_RATIO))
    lo, hi = estimate_seconds(unique)
    return {"ok": True, "total": total, "unique_est": unique, "est_low": lo, "est_high": hi,
            "use_search": use_search}  # resolved mode (may have auto-fallen-back to Practo search


@app.get("/api/download")
async def download(path: str):
    full = os.path.abspath(path)
    if full.startswith(os.path.abspath(DOWNLOADS)) and os.path.isfile(full):
        return FileResponse(full, filename=os.path.basename(full), media_type="text/csv")
    return {"error": "not found"}


def stub(d):
    return {k: d.get(k) for k in
            ("id", "clinic_key", "doctor_name", "specialty", "clinic_name",
             "locality", "city", "consultation_fee", "recommendation")}


async def scrape_stream(city, query, use_search, offset, limit, url=None):
    t0 = time.time()
    label = "your Practo link" if url else f"“{query}” in {city}"
    yield sse({"type": "status", "msg": f"Reading Practo results for {label}…"})
    session = await ensure_listing(city, query, use_search, url)
    doctors = session["doctors"]
    if not doctors:
        yield sse({"type": "error", "msg": "No doctors found — try another city/clinic type."})
        return

    sl = doctors[offset: offset + limit]
    yield sse({"type": "doctors", "doctors": [stub(d) for d in sl],
               "offset": offset, "grand_total": len(doctors)})

    # Lazily fetch Practo profiles (address + map pin) just for this slice.
    todo = [d for d in sl if not d.get("_profiled")]
    if todo:
        yield sse({"type": "status", "msg": f"Reading addresses + map pins for {len(todo)} clinics…"})
        await scrape.add_profiles(todo, asyncio.Semaphore(HTTP_CONCURRENCY), None)
        for d in todo:
            d["_profiled"] = True

    groups = {}
    for d in sl:
        groups.setdefault(d["clinic_key"], []).append(d)
    total = len(groups)
    yield sse({"type": "status",
               "msg": f"Finding real phone numbers for {total} clinics via Google Maps (live)…"})

    browser_sem = asyncio.Semaphore(BROWSER_CONCURRENCY)
    q: asyncio.Queue = asyncio.Queue()

    async def work(key, members):
        d = members[0]
        try:
            res = await scrape.maps_lookup(d, browser_sem, None)
            ok = scrape.verify(d, res)
        except Exception:
            res, ok = None, False
        lead = {"clinic_key": key, "matched": bool(ok)}
        if ok:
            email = await asyncio.to_thread(scrape.scrape_email, res["website"]) if res.get("website") else None
            lead.update({"phone": res["phone"], "website": res.get("website"), "email": email,
                         "address": res.get("address"), "maps_url": res.get("maps_url")})
        await q.put(lead)

    tasks = [asyncio.create_task(work(k, v)) for k, v in groups.items()]
    done = 0
    while done < len(tasks):
        lead = await q.get()
        done += 1
        for m in groups[lead["clinic_key"]]:
            m["real_phone"] = lead.get("phone"); m["email"] = lead.get("email")
            m["website"] = lead.get("website"); m["google_address"] = lead.get("address")
            m["google_maps_url"] = lead.get("maps_url")
            m["match_source"] = "google_maps" if lead["matched"] else "unverified"
        yield sse({"type": "lead", "lead": lead, "done": done, "total": total})

    # Write/refresh the session CSV with everything enriched so far.
    enriched = [d for d in doctors if d.get("match_source")]
    scrape.write_csv(enriched or doctors, session["csv"])
    next_off = offset + limit
    yield sse({"type": "batch_done", "csv": session["csv"], "secs": int(time.time() - t0),
               "next_offset": next_off, "remaining": max(0, len(doctors) - next_off),
               "grand_total": len(doctors)})


@app.get("/api/scrape")
async def api_scrape(city: str = "bangalore", query: str = "Dentist", use_search: bool = False,
                     offset: int = 0, limit: int = 100000, url: str = ""):
    return StreamingResponse(scrape_stream(city, query, use_search, offset, limit, url or None),
                             media_type="text/event-stream")


@app.get("/api/reset")
async def reset(city: str, query: str, use_search: bool = False):
    CACHE.pop((city, query, use_search), None)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
