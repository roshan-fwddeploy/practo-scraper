# Practo Scraper — by FwdDeploy

Free, headless lead scraper for [Practo](https://www.practo.com). Enter a **city + clinic
type** (or paste a **Practo search link**) and get each doctor's **real phone, email,
verified address, and map link** — streamed live into a web dashboard, exportable to CSV.

**$0 to run.** No paid APIs. Powered by [Scrapling](https://github.com/D4Vinci/Scrapling)
(stealth headless) + Google Maps scraping with a coordinate-verified match guard.

---

## What you get per doctor

| From Practo (free) | Added via Google Maps (free) |
| --- | --- |
| Doctor name, specialty, experience | **Real phone number** |
| Clinic / hospital name | Website (+ email if found) |
| Full street address + lat/long | Google-verified address |
| Locality, city, fee, recommendation % | Clean Google Maps URL |

> Practo only exposes a **virtual/proxy** number — never the clinic's real line or email.
> Those come from Google Maps / the clinic's own website, matched by clinic name + coordinates.

## How it works

```
city + type  ──►  Practo listing (HTTP, ~1s/page)  ──►  doctors
   or paste a Practo URL              │
                                      ▼
                          Practo profiles (HTTP)  ──►  address + map pin
                                      │
                                      ▼
                  Google Maps per clinic (stealth headless)  ──►  real phone / website / email
                          verified by distance to Practo's pin (≤300 m)
                                      │
                                      ▼
                                  CSV  +  live dashboard
```

Practo pages are server-rendered, so they're fetched over plain HTTP (fast, concurrent).
Only Google Maps needs the stealth browser (the phone loads via JS). Clinics are de-duplicated
so each real clinic is looked up once.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate     # or: uv venv
uv pip install "scrapling[fetchers]" fastapi "uvicorn[standard]"
scrapling install          # one-time: downloads the stealth browser (Camoufox)
```

## Run

**Web dashboard** (recommended):
```bash
python server.py           # http://127.0.0.1:8765
```
Enter a city + clinic type, or paste a Practo link. See total results + a time estimate,
choose **all-at-once** or **in batches**, watch leads stream in, and export CSV.

**CLI**:
```bash
python scrape.py --city bangalore --query "Dentist" --limit 50
python scrape.py --city mumbai --query "Dermatologist" --limit 200 --concurrency 8
```

## Speed & scale

- ~5–6 s per clinic (the Google Maps stealth fetch is the bottleneck — no free tool removes it).
- ~8 min for 900 doctors, ~15–18 min for 2000, all unattended.
- For thousands-in-minutes you need **residential proxy rotation** (`--proxy`), which is paid.
  Scrapling supports it; the free route is single-IP and rate-limited by Google.

## ⚠️ Legal / responsible use

- Practo's `robots.txt` disallows `/search`; this tool defaults to the **allowed** SEO
  listing paths (`/<city>/<specialty>`) and never calls Practo's internal APIs.
- Doctor names/phones/addresses are **personal data** under India's **DPDP Act**. There's a
  public-data exemption, but using scraped data for commercial outreach carries obligations.
  **Get legal sign-off before running lead-gen campaigns.** This is not legal advice.
- Scrape only what you need, throttle, and don't redistribute raw datasets.

---

© FwdDeploy. Internal tool.
