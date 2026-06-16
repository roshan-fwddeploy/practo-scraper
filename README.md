# Practo Scraper + Google Places enrichment

Scrape Practo doctor listings for a **city + specialty/issue**, then enrich each clinic
with its **real phone, website, verified address, and Maps link** via Google Places.
Outputs a CSV to `~/Downloads/`.

## What you get per doctor

| Reliable from Practo (free) | Added by Google Places |
| --- | --- |
| Doctor name, specialty, experience | **Real phone number** |
| Clinic / hospital name | Website (+ email if found on it) |
| Full street address | Google-verified address |
| Practo map link (lat/long) | Clean Google Maps URL |
| Locality, city, fee, recommendation % | |

> ⚠️ Practo itself **never** exposes a clinic's real phone or email — its "Contact Clinic"
> number is a rotating virtual/proxy line. The real number comes from Google Places.

---

## Setup

```bash
cd ~/projects/practo-scraper
npm install            # installs Playwright
npx playwright install chromium   # only if Chromium isn't already cached
```

### Google Maps API key (2 minutes) — needed for real phones

1. Go to **https://console.cloud.google.com/** and sign in.
2. Create a project (top bar → project dropdown → **New Project** → name it e.g. `practo-leads`).
3. Enable the API: search **"Places API (New)"** in the top search bar →
   open it → **Enable**. (Enable plain "Places API" too if prompted.)
4. Create the key: **APIs & Services → Credentials → + Create Credentials → API key**.
   Copy the key.
5. (Recommended) Click the key → **API restrictions → Restrict key → Places API (New)**
   so the key can't be abused if leaked.
6. Billing: Google requires a billing account on file even for free usage.
   **APIs & Services → Billing → link a card.** You will **not** be charged inside the
   free tier (see limits below). New accounts also get a one-time **$300 / 90-day** credit.

Put the key in your shell for the run:

```bash
export GOOGLE_MAPS_API_KEY="paste-your-key-here"
```

> Tip: add that line to `~/.zshrc` so it's always available, or create a `.env` and
> `export $(grep -v '^#' .env | xargs)` before running.

### Free tier / cost

| Call | Google SKU | Free / month | After free |
| --- | --- | --- | --- |
| Find clinic (IDs only) | Text Search Essentials | **Unlimited** | — |
| Real phone + website | Place Details **Enterprise** | **1,000 / month** | ~$0.02 each |

The scraper **de-duplicates clinics before paying** — many doctors share one clinic, so
N doctors usually cost fewer than N lookups. It prints how many billed lookups it used.

---

## Usage

Phone enrichment mode is **automatic**: if `GOOGLE_MAPS_API_KEY` is set, it uses the
**Places API** (fast, scales to thousands). If not, it uses the **free Google Maps scrape**
(good for hundreds, slower, CAPTCHA-limited). Force the free route with `--free-maps`.

```bash
# quick test (free route, no key needed)
node scrape.js --city bangalore --query "Dentist" --limit 10

# SCALE run — ~900 dentists, Places API, high concurrency  (~2-3 min, free under 1000/mo)
export GOOGLE_MAPS_API_KEY="your-key"
node scrape.js --city bangalore --query "Dentist" --limit 900 --concurrency 20

# other examples
node scrape.js --city mumbai --query "Dermatologist" --limit 200 --concurrency 20
```

The `--query` is slugified into Practo's SEO path, e.g. `"Dentist"` → `/bangalore/dentist`,
`"General Physician"` → `/bangalore/general-physician`. If a term doesn't resolve to a
Practo specialty page you'll get 0 results — fall back to `--use-search "your term"`.

### Speed & scale

- **Listing pages are fetched in parallel** (capped at 6 concurrent to stay under Cloudflare).
- **Enrichment runs at `--concurrency`** (default 6; use 20-30 for the Places API).
- The **Places API is the only way to do thousands in minutes** — the free Maps scrape tops
  out around 1-2 lookups/sec/IP before Google starts showing CAPTCHAs.
- **Cost reminder:** the 1,000 free Place Details calls are *per month across all runs* on
  your billing account. ~900 unique clinics in one run = free. Don't loop it — re-running
  burns the monthly allowance (~$0.02 each past 1,000). The script prints the billed count.
- For **repeated** thousands-scale scraping you'll need **residential proxy rotation**
  (both Practo and Google block a single IP at high volume) — not included here.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--city`   | `bangalore` | Practo city slug |
| `--query`  | `Dentist`   | Specialty or issue (as you'd type on Practo) |
| `--limit`  | `10`        | Max doctors to scrape |
| `--pages`  | auto        | Max listing pages to walk |
| `--no-email` | off       | Skip website email scraping (faster) |
| `--headful`  | **on**    | Show the browser window (default; Practo blocks headless) |
| `--headless` | off       | Force headless (often returns 0 results — Practo serves empty to headless) |
| `--use-search` | off     | Use the `/search?q=` URL instead of the SEO path. Needed only for free-text "issues" that don't map to a specialty slug. **Note: this path is robots-disallowed** (see below). |
| `--out`    | `~/Downloads/practo_<city>_<query>_<ts>.csv` | CSV path |

Without a key the scraper still runs and fills every Practo field — only `Phone` and
`Email` stay blank.

## Notes on scale & politeness

- The scraper adds randomized delays between Practo page loads. Keep `--limit` reasonable
  and don't run many jobs in parallel from one IP, or Practo may rate-limit you.
- Stay under **1,000 unique clinics/month** to remain in Google's free tier.
- **Headless is blocked.** Practo serves empty results to `chrome-headless-shell`, so the
  scraper runs **headful by default** (a browser window opens). This is reliable from one
  residential IP for hundreds of doctors. Profile pages sit behind **Cloudflare** — at
  thousands of requests you'd start hitting bot challenges and need residential proxy
  rotation + stealth. That's out of scope here (and stays under your free Google tier anyway).

## ⚠️ robots.txt & legal — read before scaling up

This was researched and verified, not guessed:

- **robots.txt:** Practo's `robots.txt` **disallows `/search`** and all internal APIs
  (`/health/api*`, `/marketplace-api/*`, `/client-api/*`). This scraper therefore defaults
  to the **SEO landing path `/<city>/<specialty>`, which is *allowed*** and returns the same
  cards. Avoid `--use-search` for bulk runs — it hits the disallowed path. We never call
  Practo's internal phone APIs; the real phone comes from Google instead.
- **India DPDP Act:** Doctor names/addresses/phones are *personal data*. The Act has a
  **publicly-available-data exemption** (s.3(c)(ii)) that likely covers a public directory
  like Practo — but the regulatory position is **evolving**, and using scraped personal data
  for **commercial outreach/marketing** raises separate obligations. Web scraping itself is
  not explicitly illegal in India, but **get legal sign-off before using this data for a
  lead-gen campaign.** This README is not legal advice.
- **Be a good citizen:** scrape only what you need, throttle, cache results, and don't
  redistribute the raw dataset.
