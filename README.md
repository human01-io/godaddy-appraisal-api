# GoGreedy

A Cloudflare Worker that wraps GoDaddy's internal domain appraisal engine, returning estimated values, comparable sales, domain availability, and alternative TLD suggestions — all via a simple REST API.

Built on [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-rendering/) with stealth patches to bypass Akamai bot detection.

## Features

- Domain appraisal value (GoDaddy GoValue)
- Comparable domain sales data
- Domain availability and pricing
- Alternative TLD suggestions (`.mx`, `.io`, `.app`, `.ai` prioritized)
- 16 market/locale options with localized pricing
- In-memory caching per isolate
- CORS enabled

## Prerequisites

- Cloudflare account with [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) enabled
- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)

## Setup

```bash
git clone https://github.com/human01-io/godaddy-appraisal-api.git
cd godaddy-appraisal-api
npm install
wrangler login
```

## Development

```bash
npm run dev
# Worker runs at http://localhost:8787
```

## Deploy

```bash
npm run deploy
```

## API Reference

### Base URL

```
https://domain-appraisal.<your-subdomain>.workers.dev
```

---

### `GET /health`

Health check and cache status.

**Request:**
```bash
curl https://your-worker.workers.dev/health
```

**Response:**
```json
{
  "status": "ok",
  "cache_size": 3,
  "default_market": "mx",
  "available_markets": ["us", "mx", "uk", "ca", "au", "in", "br", "es", "de", "fr", "it", "jp", "sg", "co", "ar", "cl"]
}
```

---

### `GET /appraisal/:domain`

Fetch appraisal value, availability, and alternative TLDs for a single domain.

**Parameters:**

| Parameter | Location | Required | Default | Description |
|-----------|----------|----------|---------|-------------|
| `domain`  | path     | yes      | —       | Domain to appraise (e.g. `example.com`) |
| `market`  | query    | no       | `mx`    | Market/locale for pricing and TLD suggestions |

**Available Markets:**

| Code | Locale | Currency | GoDaddy Subdomain |
|------|--------|----------|--------------------|
| `us` | en-US  | USD      | www.godaddy.com    |
| `mx` | es-MX  | MXN      | mx.godaddy.com     |
| `uk` | en-GB  | GBP      | uk.godaddy.com     |
| `ca` | en-CA  | CAD      | ca.godaddy.com     |
| `au` | en-AU  | AUD      | au.godaddy.com     |
| `in` | en-IN  | INR      | in.godaddy.com     |
| `br` | pt-BR  | BRL      | br.godaddy.com     |
| `es` | es-ES  | EUR      | es.godaddy.com     |
| `de` | de-DE  | EUR      | de.godaddy.com     |
| `fr` | fr-FR  | EUR      | fr.godaddy.com     |
| `it` | it-IT  | EUR      | it.godaddy.com     |
| `jp` | ja-JP  | JPY      | jp.godaddy.com     |
| `sg` | en-SG  | SGD      | sg.godaddy.com     |
| `co` | es-CO  | COP      | co.godaddy.com     |
| `ar` | es-AR  | ARS      | ar.godaddy.com     |
| `cl` | es-CL  | CLP      | cl.godaddy.com     |

**Request:**
```bash
# Default market (mx)
curl https://your-worker.workers.dev/appraisal/phantom.com

# US market (USD pricing)
curl https://your-worker.workers.dev/appraisal/phantom.com?market=us
```

**Response (200 OK):**
```json
{
  "domain": "phantom.com",
  "govalue": 25000,
  "comparable_sales": [
    {
      "domain": "phantom.io",
      "price": 15000,
      "date": "2023-06-15"
    },
    {
      "domain": "specter.com",
      "price": 12500,
      "date": "2023-03-22"
    }
  ],
  "reasons": [
    "Short, memorable domain name",
    "High commercial appeal",
    "Strong keyword value"
  ],
  "market": "us",
  "currency": "USD",
  "availability": {
    "available": false,
    "tld": "com",
    "price": null,
    "price_display": null,
    "list_price": null,
    "is_promo": false,
    "icann_fee": false
  },
  "alternative_tlds": [
    {
      "domain": "phantom.mx",
      "tld": "mx",
      "available": true,
      "price": 299,
      "price_display": "$299.00",
      "list_price": 599
    },
    {
      "domain": "phantom.io",
      "tld": "io",
      "available": false,
      "price": null,
      "price_display": null,
      "list_price": null
    },
    {
      "domain": "phantom.app",
      "tld": "app",
      "available": true,
      "price": 1499,
      "price_display": "$14.99",
      "list_price": 1999
    },
    {
      "domain": "phantom.ai",
      "tld": "ai",
      "available": false,
      "price": null,
      "price_display": null,
      "list_price": null
    },
    {
      "domain": "phantom.net",
      "tld": "net",
      "available": true,
      "price": 1399,
      "price_display": "$13.99",
      "list_price": 1699
    },
    {
      "domain": "phantom.org",
      "tld": "org",
      "available": true,
      "price": 999,
      "price_display": "$9.99",
      "list_price": 1199
    }
  ]
}
```

> **Note:** The `comparable_sales`, `reasons`, and `govalue` fields come directly from GoDaddy's appraisal engine. The exact structure may vary per domain. The example above shows a representative response — actual field names from GoDaddy may differ slightly.

**Response (cached):**

When served from cache, the response includes `"_cached": true`.

**Error Responses:**

```json
// 400 - Invalid domain
{ "error": "Invalid domain. Example: /appraisal/example.com" }

// 502 - Akamai blocked the request
{ "error": "BLOCKED_BY_AKAMAI" }

// 502 - Rate limited by GoDaddy
{ "error": "RATE_LIMITED" }

// 502 - Browser Rendering quota exceeded
{ "error": "Unable to create new browser: code: 429: message: Rate limit exceeded" }
```

---

### `GET /batch`

Appraise multiple domains sequentially (max 5 per request).

**Parameters:**

| Parameter | Location | Required | Default | Description |
|-----------|----------|----------|---------|-------------|
| `domains` | query    | yes      | —       | Comma-separated domain list |
| `market`  | query    | no       | `mx`    | Market/locale for pricing |

**Request:**
```bash
curl "https://your-worker.workers.dev/batch?domains=phantom.com,swif.com,yobot.com&market=us"
```

**Response (200 OK):**
```json
{
  "phantom.com": {
    "domain": "phantom.com",
    "govalue": 25000,
    "market": "us",
    "currency": "USD",
    "availability": { "..." },
    "alternative_tlds": [ "..." ]
  },
  "swif.com": {
    "domain": "swif.com",
    "govalue": 4200,
    "market": "us",
    "currency": "USD",
    "availability": { "..." },
    "alternative_tlds": [ "..." ]
  },
  "yobot.com": {
    "error": "RATE_LIMITED"
  }
}
```

> **Note:** Batch requests are processed sequentially. Each domain launches a browser session, so batch requests consume more Browser Rendering quota and take longer (~15-30s per domain).

---

### `GET /` (root)

Returns same response as `/health`.

### Any other path

Returns a 404 with usage hints:

```json
{
  "error": "Not found",
  "usage": {
    "single": "/appraisal/example.com",
    "with_market": "/appraisal/example.com?market=us",
    "batch": "/batch?domains=a.com,b.com&market=mx",
    "health": "/health",
    "markets": ["us", "mx", "uk", "ca", "au", "in", "br", "es", "de", "fr", "it", "jp", "sg", "co", "ar", "cl"]
  }
}
```

## Rate Limits

This API is subject to two layers of rate limiting:

| Limit | Free Plan | Paid Plan ($5/mo) |
|-------|-----------|-------------------|
| Browser time per day | 10 minutes | Unlimited (usage-based) |
| Concurrent browsers | 3 | 30 |
| New instances per minute | 3 | 30 |

Each appraisal takes ~10-15 seconds of browser time, so the free plan supports roughly **40-60 appraisals per day**.

The daily quota resets at **00:00 UTC**.

## How It Works

1. Launches a headless Chromium browser via Cloudflare Browser Rendering
2. Applies stealth patches (webdriver, chrome runtime, WebGL, plugins, etc.) to bypass Akamai bot detection
3. Navigates to GoDaddy's domain appraisal page with market-specific cookies
4. Intercepts the internal `/v1/appraisal/` API response
5. Makes additional in-browser fetch calls to GoDaddy's domain search APIs for availability and TLD alternatives
6. Explicitly looks up priority TLDs (`.mx`, `.io`, `.app`, `.ai`) if missing from initial results
7. Returns the combined, enriched response

## Configuration

Environment variables in `wrangler.toml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL` | `3600` | Cache duration in seconds per domain+market |

## License

MIT
