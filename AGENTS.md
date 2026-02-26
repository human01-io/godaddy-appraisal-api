# GoGreedy — Agent Context

## What This Is

A Cloudflare Worker that scrapes GoDaddy's internal domain appraisal engine using headless Chromium (via CF Browser Rendering). Returns domain valuations, availability, comparable sales, and alternative TLD pricing through a REST API.

**Production URL:** `https://gogreedy.phantom.mx`
**GitHub:** `https://github.com/human01-io/godaddy-appraisal-api`

## Architecture

Single file: `src/index.ts` (~910 lines). Contains everything:
- `HTML_UI` — inline HTML/CSS/JS for the web UI served at `/`
- `STEALTH_SCRIPT` — 13 patches to bypass Akamai bot detection in headless Chrome
- `fetchAppraisal()` — core function: launches browser, navigates, intercepts APIs, returns enriched data
- Route handler — serves UI, health, single appraisal, batch appraisal

## How It Works (Request Flow)

1. Launch headless Chromium via `@cloudflare/puppeteer`
2. Apply stealth patches (webdriver, chrome runtime, WebGL, plugins, etc.)
3. Set market cookies, randomize UA + viewport
4. Block images/fonts/media/trackers via request interception
5. Navigate to `https://{market}.godaddy.com/domain-value-appraisal/appraisal/?domainToCheck={domain}`
6. Intercept the `api.godaddy.com/v1/appraisal/{domain}` response (or direct-fetch as fallback)
7. Make in-browser fetch calls to domainfind endpoints for availability + TLD pricing
8. Call `window.stop()` to kill page activity and save browser time
9. Build enriched response, cache it, return

## The Three GoDaddy Endpoints

### 1. Appraisal: `api.godaddy.com/v1/appraisal/{domain}`
- Returns: `govalue`, `comparable_sales`, `reasons`, `govalue_limits`
- Can return 429 (rate limited), 403 (Akamai blocked), 410 (domain can't be appraised)
- Status "MASKED_DOMAIN" for protected domains like google.com
- **Currently throws RATE_LIMITED on 429, killing the entire request** (known issue — should be non-fatal)

### 2. Exact: `{host}/domainfind/v1/search/exact?key=appraisals_search&q={domain}`
- Returns availability + pricing for the exact domain queried
- **Critical response fields:**
  - `ExactMatchDomain.IsAvailable` — authoritative availability (true/false)
  - `ExactMatchDomain.IsPurchasable` — whether it can be bought
  - `Products[0].ProductId` — 0 = taken, >0 = available
  - `Products[0].PriceInfo.CurrentPrice` — 0 = taken, >0 = available
  - `Products[0].PriceInfo.CurrentPriceDisplay` — "" = taken, has value = available
- **Available domain example** (blorpzax99.com): `ProductId=101, CurrentPrice=4.99, CurrentPriceDisplay="$4.99"`, no ExactMatchDomain
- **Taken domain example** (google.com): `ProductId=0, CurrentPrice=0, CurrentPriceDisplay=""`, `ExactMatchDomain.IsAvailable=false`
- Also used for priority TLD lookups (e.g., `sld.mx`, `sld.io`) when missing from spins

### 3. Spins: `{host}/domainfind/v1/search/spins?key=appraisals_search&q={domain}&pagesize=20&tlds=...`
- Returns alternative TLD suggestions with pricing
- **Products array = generic TLD pricing, NOT domain-specific availability**
- For available SLDs: returns many TLD products with real prices (all available)
- For taken SLDs: returns minimal products + `RecommendedDomains` (aftermarket suggestions)
- Spins Products always include the queried TLD even if taken (with `ProductId=0` / zero price)
- `key=appraisals_search` is the ONLY working key — `dpp`, `domain_search`, `domain_search_find` all 404

## Availability Detection Logic

All TLDs (priority + spins) are verified via exact lookups to get authoritative `ExactMatchDomain.IsAvailable`.

```
Main domain (from exact):
  ExactMatchDomain.IsAvailable === true  →  available
  Fallback: ProductId > 0 && CurrentPriceDisplay !== ""  →  available

Alternative TLDs (all verified via exact lookups):
  _emd.IsAvailable === true  →  available (ExactMatchDomain attached as _emd)
```

**WARNING:** The spins endpoint returns generic TLD pricing, NOT domain-specific availability. `ProductId > 0` just means the TLD exists as a product — a taken domain like `agents.com` still shows `ProductId: 101` with a registration price. Never trust spins for availability; always verify with exact lookups.

**WARNING:** `CurrentPrice != null` is NOT a valid check — taken domains return `CurrentPrice: 0` (not null). Use `CurrentPriceDisplay !== ""` or `ProductId > 0`.

## Known Issues & Gotchas

### Rate Limiting
- GoDaddy returns 429 on the appraisal endpoint after rapid requests
- The domainfind endpoints (exact/spins) are separate and usually NOT rate limited
- **Current code throws RATE_LIMITED on appraisal 429, preventing domainfind calls** — this should be fixed to return partial data (availability + TLDs without govalue)
- No in-code request spacing currently (was removed during a revert) — consider re-adding MIN_REQUEST_GAP_MS

### Caching
- In-memory cache only (per isolate, resets on cold start)
- CF Cache API layer was added then reverted — can be re-added for persistence across deploys
- CACHE_TTL = 3600s (1 hour) via wrangler.toml env var
- Cached responses include `_cached: true`

### Browser Time Limits (Cloudflare)
| | Free Plan | Paid Plan ($5/mo) |
|---|---|---|
| Browser time/day | 10 minutes | Unlimited (usage-based) |
| Concurrent browsers | 3 | 30 |
| New instances/min | 3 | 30 |

Each appraisal takes ~7-10 seconds of browser time. Free plan ≈ 40-60 appraisals/day.

### Stealth & Akamai
- Non-www subdomains (e.g., `sg.godaddy.com`) may block search page navigation with "Access Denied"
- The appraisal page (`/domain-value-appraisal/`) works on all market subdomains
- Stealth patches are critical — removing any can cause Akamai to block requests
- JS must NOT be blocked in request interception (needed for Akamai challenge)

### API Key Quirk
- `key=appraisals_search` is the only working key for domainfind endpoints
- The comment in code says "Use key=dpp" — this is WRONG/outdated, `dpp` returns 404
- `/v1/domains/available` (official GoDaddy API) requires auth — can't use from browser context

## File Structure

```
cf-worker/
├── src/index.ts      # Everything — UI, stealth, scraping, routes (~910 lines)
├── wrangler.toml     # Worker config, Browser binding, CACHE_TTL env var
├── package.json      # @cloudflare/puppeteer + wrangler
├── tsconfig.json     # ESNext, bundler resolution, strict
├── README.md         # API documentation with examples
├── .gitignore        # node_modules, .wrangler, dist, .dev.vars
├── CLAUDE.md
└── AGENTS.md
```

## API Routes

| Route | Description |
|---|---|
| `GET /` | Serves the HTML UI |
| `GET /health` | Cache size, default market, available markets |
| `GET /appraisal/:domain?market=xx` | Single domain appraisal (default market: mx) |
| `GET /batch?domains=a,b&market=xx` | Batch appraisal, max 5 domains, sequential |

## Markets

16 supported: `us`, `mx`, `uk`, `ca`, `au`, `in`, `br`, `es`, `de`, `fr`, `it`, `jp`, `sg`, `co`, `ar`, `cl`. Default: `mx`. Each maps to a GoDaddy subdomain, locale cookie, and currency.

## Development

```bash
npm run dev      # wrangler dev at localhost:8787
npm run deploy   # wrangler deploy to production
```

## Things That Have Been Tried and Failed

- `key=dpp` for domainfind → 404
- `key=domain_search_find` for domainfind → 404
- `/v1/domains/available` API → 401 (requires API key)
- `/domainsapi/v1/search/exact` → 404
- `/aftermarket/v1/listings` → 401
- Navigating to `/domainsearch/find` on non-www subdomains → Access Denied by Akamai
- Using `p.Available` or `p.Buyable` fields from domainfind Products → these fields don't exist in the response with `key=appraisals_search`
- `networkidle0` page wait → too slow, `domcontentloaded` + direct fetch fallback is faster
