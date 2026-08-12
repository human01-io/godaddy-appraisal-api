import puppeteer, { Browser } from "@cloudflare/puppeteer";
import HTML_UI from "./ui.html";

interface Env {
  BROWSER: Fetcher;
  CACHE_TTL: string;
  DB: D1Database;
  // Self service binding — used to fan out RDAP checks across multiple
  // invocations, since each request is capped at 50 subrequests
  SELF?: Fetcher;
}

// In-memory cache (per isolate, resets on cold start)
const cache = new Map<string, { data: any; ts: number }>();

// Cloudflare wholesale TLD pricing cache (USD, refreshed every 6 hours)
let cfPrices: Record<string, { registration: number; renewal: number }> | null = null;
let cfPricesFetchedAt = 0;
const CF_PRICES_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function getCfPrices(): Promise<Record<string, { registration: number; renewal: number }>> {
  if (cfPrices && Date.now() - cfPricesFetchedAt < CF_PRICES_TTL) return cfPrices;
  try {
    const res = await fetch("https://cfdomainpricing.com/prices.json");
    if (res.ok) {
      cfPrices = await res.json() as Record<string, { registration: number; renewal: number }>;
      cfPricesFetchedAt = Date.now();
    }
  } catch { /* keep stale cache if fetch fails */ }
  return cfPrices || {};
}

// Supported GoDaddy markets: subdomain, market cookie, currency
const MARKETS: Record<string, { subdomain: string; market: string; currency: string }> = {
  us:  { subdomain: "www",  market: "en-US", currency: "USD" },
  mx:  { subdomain: "mx",   market: "es-MX", currency: "MXN" },
  uk:  { subdomain: "uk",   market: "en-GB", currency: "GBP" },
  ca:  { subdomain: "ca",   market: "en-CA", currency: "CAD" },
  au:  { subdomain: "au",   market: "en-AU", currency: "AUD" },
  in:  { subdomain: "in",   market: "en-IN", currency: "INR" },
  br:  { subdomain: "br",   market: "pt-BR", currency: "BRL" },
  es:  { subdomain: "es",   market: "es-ES", currency: "EUR" },
  de:  { subdomain: "de",   market: "de-DE", currency: "EUR" },
  fr:  { subdomain: "fr",   market: "fr-FR", currency: "EUR" },
  it:  { subdomain: "it",   market: "it-IT", currency: "EUR" },
  jp:  { subdomain: "jp",   market: "ja-JP", currency: "JPY" },
  sg:  { subdomain: "sg",   market: "en-SG", currency: "SGD" },
  co:  { subdomain: "co",   market: "es-CO", currency: "COP" },
  ar:  { subdomain: "ar",   market: "es-AR", currency: "ARS" },
  cl:  { subdomain: "cl",   market: "es-CL", currency: "CLP" },
};

const DEFAULT_MARKET = "mx";

// Feature flag: GoDaddy appraisal scraping (headless browser + GoValue).
// When false, no browser is launched — responses contain availability +
// pricing only (RDAP + Cloudflare wholesale prices). Flip to true to
// re-enable appraisals.
const APPRAISAL_ENABLED: boolean = false;

const BASE_PRIORITY_TLDS = ["ai", "io", "dev", "app", "co"];

// ISO country code → market key
const COUNTRY_TO_MARKET: Record<string, string> = {
  US: "us", MX: "mx", GB: "uk", CA: "ca", AU: "au", IN: "in",
  BR: "br", ES: "es", DE: "de", FR: "fr", IT: "it", JP: "jp",
  SG: "sg", CO: "co", AR: "ar", CL: "cl",
};

// Market key → country TLD (null = don't add, e.g. "us" → no .us)
function countryTldForMarket(market: string): string | null {
  if (market === "us") return null;
  return MARKETS[market] ? market : null;
}

function priorityTldsForMarket(market: string): string[] {
  const ctld = countryTldForMarket(market);
  if (!ctld || BASE_PRIORITY_TLDS.includes(ctld)) return BASE_PRIORITY_TLDS;
  return [...BASE_PRIORITY_TLDS, ctld];
}

// Popular alternative TLDs — used as the pool for /batch (a full sweep per
// domain would exceed the Workers subrequest cap) and as a floor for the
// full sweep in case the pricing feed is unavailable.
const ALL_ALT_TLDS = [
  "com", "net", "org", "ai", "io", "dev", "app", "co",
  "xyz", "shop", "store", "tech", "online", "site", "info",
  "biz", "me", "tv", "cc", "gg", "club", "world", "land", "so", "us",
];

// RDAP bootstrap cache: maps TLD → RDAP server URL
let rdapBootstrap: Record<string, string> | null = null;
let rdapBootstrapTs = 0;

async function loadRdapBootstrap(): Promise<Record<string, string>> {
  if (rdapBootstrap && Date.now() - rdapBootstrapTs < 86400000) {
    return rdapBootstrap;
  }
  try {
    const resp = await fetch("https://data.iana.org/rdap/dns.json");
    if (!resp.ok) throw new Error(`RDAP bootstrap ${resp.status}`);
    const data = await resp.json() as { services: [string[], string[]][] };
    const map: Record<string, string> = {};
    for (const [tlds, urls] of data.services) {
      for (const tld of tlds) {
        map[tld.toLowerCase()] = urls[0];
      }
    }
    rdapBootstrap = map;
    rdapBootstrapTs = Date.now();
    return map;
  } catch (err) {
    // Fall back to stale bootstrap if refresh fails; only die with nothing cached
    if (rdapBootstrap) return rdapBootstrap;
    throw err;
  }
}

async function checkRdap(domain: string, bootstrap: Record<string, string>): Promise<boolean | null> {
  const tld = domain.split(".").pop()?.toLowerCase();
  if (!tld || !bootstrap[tld]) return null;
  const url = bootstrap[tld].replace(/\/$/, "") + "/domain/" + domain;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/rdap+json" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status === 200) return false; // exists = taken
    if (resp.status === 404) return true;  // not found = available
    return null;
  } catch {
    return null;
  }
}

async function checkAllRdap(
  sld: string,
  tlds: string[],
): Promise<Record<string, boolean | null>> {
  const bootstrap = await loadRdapBootstrap();
  const results: Record<string, boolean | null> = {};
  const run = async (tld: string) => {
    results[tld] = await checkRdap(`${sld}.${tld}`, bootstrap);
  };
  await Promise.allSettled(tlds.map(run));
  // One retry pass for transient failures (timeouts, registry rate limits).
  // TLDs with no RDAP server can never resolve — don't waste subrequests.
  // Caps keep the worst case under the per-invocation subrequest budget.
  const failed = tlds
    .filter((t) => results[t] === null && bootstrap[t.split(".").pop()!])
    .slice(0, 12);
  if (failed.length) {
    await Promise.allSettled(failed.map(run));
  }
  // DNS-over-HTTPS fallback for TLDs whose RDAP is missing or unreachable
  // (.io/.us/.mx have no bootstrap entry; some registries reject requests
  // from Workers). NS records prove taken; NXDOMAIN implies available.
  const unresolved = tlds.filter((t) => results[t] === null).slice(0, 12);
  await Promise.allSettled(
    unresolved.map(async (tld) => {
      try {
        const resp = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${sld}.${tld}&type=NS`,
          {
            headers: { Accept: "application/dns-json" },
            signal: AbortSignal.timeout(4000),
          },
        );
        if (!resp.ok) return;
        const data = await resp.json() as any;
        if (data.Answer?.some((a: any) => a.type === 2)) results[tld] = false;
        else if (data.Status === 3) results[tld] = true;
      } catch { /* keep unknown */ }
    }),
  );
  return results;
}


// Comprehensive stealth patches to bypass Akamai bot detection
const STEALTH_SCRIPT = `
  // 1. Hide webdriver flag (primary detection signal)
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Also delete it from the prototype
  delete Object.getPrototypeOf(navigator).webdriver;

  // 2. Mock chrome runtime (missing in headless)
  window.chrome = {
    runtime: {
      onConnect: { addListener: function() {} },
      onMessage: { addListener: function() {} },
      connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {} }; },
      sendMessage: function() {},
      id: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
    },
    loadTimes: function() {
      return { commitLoadTime: Date.now() / 1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now() / 1000 - 0.1, startLoadTime: Date.now() / 1000 - 0.1, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true };
    },
    csi: function() { return { onloadT: Date.now(), pageT: Date.now() / 1000, startE: Date.now(), tran: 15 }; },
    app: { isInstalled: false, getDetails: function() { return null; }, getIsInstalled: function() { return false; }, installState: function() { return 'disabled'; }, runningState: function() { return 'cannot_run'; } },
  };

  // 3. Fix permissions API
  const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(params);

  // 4. Fix plugins array (headless Chrome has empty plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1 },
        { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 1 },
        { name: 'Native Client', description: '', filename: 'internal-nacl-plugin', length: 2 },
      ];
      plugins.refresh = function() {};
      return plugins;
    },
  });

  // 5. Fix languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'language', { get: () => 'en-US' });

  // 6. Fix platform
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // 7. Fix hardware concurrency (headless often reports wrong value)
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

  // 8. Fix device memory
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

  // 9. Prevent detection of automation via console.debug
  const originalConsoleDebug = console.debug;
  console.debug = function(...args) {
    if (args[0] && typeof args[0] === 'string' && args[0].includes('puppeteer')) return;
    return originalConsoleDebug.apply(console, args);
  };

  // 10. Fix WebGL vendor/renderer (headless shows "Google SwiftShader")
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
  };

  const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter2.call(this, parameter);
  };

  // 11. Fix iframe contentWindow detection
  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function() {
    return originalAttachShadow.call(this, ...arguments);
  };

  // 12. Fix Notification.permission
  if (typeof Notification !== 'undefined') {
    Object.defineProperty(Notification, 'permission', { get: () => 'default' });
  }

  // 13. Prevent detection via stack traces
  Error.prepareStackTrace = undefined;
`;

// Build the alternative_tlds list from RDAP results + Cloudflare pricing
function buildAlternatives(
  sld: string,
  altTlds: string[],
  prioTlds: string[],
  rdapAvail: Record<string, boolean | null>,
  cfTldPrices: Record<string, { registration: number; renewal: number }>,
) {
  const mapped = altTlds.map((tld) => {
    const rdap = rdapAvail[tld];
    const cf = cfTldPrices[tld];
    // RDAP is authoritative; if null (unknown TLD), fall back to unavailable
    const available = rdap === true;
    return {
      domain: `${sld}.${tld}`,
      tld,
      available,
      status: rdap === true ? "available" : rdap === false ? "taken" : "unknown",
      price: cf?.registration ?? null,
      price_display: cf ? `$${cf.registration.toFixed(2)}` : null,
      renewal_price: cf?.renewal ?? null,
    };
  });

  // Sort: priority TLDs first (in order), then available cheapest-first,
  // then taken/unknown alphabetically
  mapped.sort((a, b) => {
    const aIdx = prioTlds.indexOf(a.tld);
    const bIdx = prioTlds.indexOf(b.tld);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available) {
      const ap = a.price ?? Infinity;
      const bp = b.price ?? Infinity;
      if (ap !== bp) return ap - bp;
    }
    return a.tld.localeCompare(b.tld);
  });

  return mapped;
}

// Availability-only lookup: RDAP + Cloudflare wholesale pricing.
// No browser, no GoDaddy — fast and free of appraisal rate limits.
async function fetchAvailability(
  env: Env,
  domain: string,
  marketKey: string = DEFAULT_MARKET,
  tldPool: "full" | "popular" = "full",
): Promise<any> {
  const prioTlds = priorityTldsForMarket(marketKey);
  const sld = domain.split(".")[0];
  const queriedTld = domain.includes(".") ? domain.split(".").slice(1).join(".") : "";

  const cacheTtl = parseInt(env.CACHE_TTL || "3600");
  const cacheKey = `${domain}:${marketKey}:${tldPool}`;
  const mkt = MARKETS[marketKey] || MARKETS[DEFAULT_MARKET];

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cacheTtl * 1000) {
    return { ...cached.data, _cached: true };
  }

  // "full" sweeps every TLD in the Cloudflare pricing feed; "popular" keeps
  // the small list (used by /batch, which must stay under the subrequest cap)
  const cfTldPrices = await getCfPrices();
  const poolTlds = tldPool === "full"
    ? [...ALL_ALT_TLDS, ...Object.keys(cfTldPrices)]
    : ALL_ALT_TLDS;
  const altTlds = [...new Set([...prioTlds, ...poolTlds])].filter(t => t !== queriedTld);

  const allRdapTlds = queriedTld ? [queriedTld, ...altTlds] : altTlds;

  // The full sweep (~420 TLDs) far exceeds the 50-subrequest cap of a single
  // invocation, so fan out in ~40-TLD chunks through the SELF service
  // binding — each child invocation gets its own subrequest budget.
  const CHUNK = 20;
  let rdapAvail: Record<string, boolean | null>;
  if (allRdapTlds.length > CHUNK && env.SELF) {
    const chunks: string[][] = [];
    for (let i = 0; i < allRdapTlds.length; i += CHUNK) {
      chunks.push(allRdapTlds.slice(i, i + CHUNK));
    }
    const parts = await Promise.all(chunks.map(async (chunk) => {
      try {
        const resp = await env.SELF!.fetch(
          `https://self/rdap-batch?sld=${encodeURIComponent(sld)}&tlds=${encodeURIComponent(chunk.join(","))}`
        );
        if (resp.ok) return await resp.json() as Record<string, boolean | null>;
      } catch { /* fall through to unknown */ }
      return Object.fromEntries(chunk.map((t) => [t, null]));
    }));
    rdapAvail = Object.assign({}, ...parts);
  } else {
    rdapAvail = await checkAllRdap(sld, allRdapTlds);
  }

  const result: any = { domain, market: marketKey, currency: mkt.currency };

  const rdapMain = queriedTld ? rdapAvail[queriedTld] : null;
  const cfMain = queriedTld ? cfTldPrices[queriedTld] : null;
  result.availability = {
    available: rdapMain === true,
    status: rdapMain === true ? "available" : rdapMain === false ? "taken" : "unknown",
    tld: queriedTld || null,
    price: cfMain?.registration ?? null,
    price_display: cfMain ? `$${cfMain.registration.toFixed(2)}` : null,
    renewal_price: cfMain?.renewal ?? null,
  };

  result.alternative_tlds = buildAlternatives(sld, altTlds, prioTlds, rdapAvail, cfTldPrices);
  result.available_tld_count = result.alternative_tlds.filter((t: any) => t.available).length
    + (result.availability.available ? 1 : 0);

  cache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

async function fetchAppraisal(
  env: Env,
  domain: string,
  marketKey: string = DEFAULT_MARKET,
): Promise<any> {
  const prioTlds = priorityTldsForMarket(marketKey);
  const sld = domain.split(".")[0];
  const queriedTld = domain.includes(".") ? domain.split(".").slice(1).join(".") : "";
  const altTlds = [...new Set([...prioTlds, ...ALL_ALT_TLDS])].filter(t => t !== queriedTld);

  const cacheTtl = parseInt(env.CACHE_TTL || "3600");
  const cacheKey = `${domain}:${marketKey}`;
  const mkt = MARKETS[marketKey] || MARKETS[DEFAULT_MARKET];

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cacheTtl * 1000) {
    return { ...cached.data, _cached: true };
  }

  // Start RDAP availability checks (including main domain) + Cloudflare pricing fetch in parallel with browser
  const allRdapTlds = queriedTld ? [queriedTld, ...altTlds] : altTlds;
  const rdapPromise = checkAllRdap(sld, allRdapTlds);
  const cfPricesPromise = getCfPrices();

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Apply stealth patches BEFORE any navigation
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);

    // Override user agent to a real Chrome UA (remove HeadlessChrome)
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ];
    await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);

    // Randomize viewport
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 },
    ];
    const vp = viewports[Math.floor(Math.random() * viewports.length)];
    await page.setViewport(vp);

    // Block heavy resources but keep JS (needed for Akamai challenge)
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const resourceType = req.resourceType();
      const reqUrl = req.url();
      if (
        resourceType === "image" ||
        resourceType === "font" ||
        resourceType === "media" ||
        reqUrl.includes("google-analytics") ||
        reqUrl.includes("googletagmanager") ||
        reqUrl.includes("facebook.net") ||
        reqUrl.includes("doubleclick.net") ||
        reqUrl.includes("hotjar") ||
        reqUrl.includes("optimizely") ||
        reqUrl.includes("nr-data.net")
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set market cookies so GoDaddy returns region-specific TLD suggestions
    await page.setCookie(
      { name: "market", value: mkt.market, domain: ".godaddy.com" },
      { name: "currency", value: mkt.currency, domain: ".godaddy.com" },
    );

    // Navigate to GoDaddy appraisal page
    let apiData: { status: number; body: any } | null = null;

    page.on("response", async (response) => {
      if (response.url().includes("api.godaddy.com/v1/appraisal/")) {
        try {
          const body = await response.json();
          apiData = { status: response.status(), body };
        } catch {
          apiData = { status: response.status(), body: null };
        }
      }
    });

    const targetUrl = `https://${mkt.subdomain}.godaddy.com/domain-value-appraisal/appraisal/?domainToCheck=${encodeURIComponent(domain)}`;
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});

    // If page's own JS already made the appraisal call, use it; otherwise fetch directly
    if (!apiData) {
      try {
        const direct = await page.evaluate(async (d: string) => {
          const r = await fetch(`https://api.godaddy.com/v1/appraisal/${d}`, {
            headers: { Accept: "application/json" },
          });
          return { status: r.status, body: await r.text() };
        }, domain);
        if (direct.status === 200) {
          apiData = { status: 200, body: JSON.parse(direct.body) };
        } else {
          apiData = { status: direct.status, body: null };
        }
      } catch {
        throw new Error("No appraisal API response intercepted");
      }
    }

    if (!apiData) {
      throw new Error("No appraisal API response intercepted");
    }

    if (apiData.status === 429) {
      throw new Error("RATE_LIMITED");
    }

    if (apiData.status === 403) {
      throw new Error("BLOCKED_BY_AKAMAI");
    }

    if (apiData.status === 410) {
      return { status: "UNAVAILABLE", domain, message: "GoDaddy cannot appraise this domain" };
    }

    if (apiData.status !== 200 || !apiData.body) {
      throw new Error(`GoDaddy returned ${apiData.status}`);
    }

    // Appraisal succeeded — now fetch main domain availability via exact endpoint
    const searchResults = await page.evaluate(`
      (async () => {
        var domain = ${JSON.stringify(domain)};
        var host = window.location.origin;
        var results = { exact: null, errors: [] };

        function doFetch(url) {
          return fetch(url, {
            headers: { "Accept": "application/json" },
            credentials: "include",
          }).then(function(r) {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.json();
          });
        }

        try {
          results.exact = await doFetch(host + "/domainfind/v1/search/exact?key=appraisals_search&q=" + encodeURIComponent(domain));
        } catch(e) {
          results.errors.push("exact: " + e);
        }

        return results;
      })()
    `) as any;

    // Stop all page activity immediately — we have everything we need
    await page.evaluate("window.stop()").catch(() => {});

    const searchExact = searchResults?.exact;

    // Build enriched result
    const result: any = { ...apiData.body, market: marketKey, currency: mkt.currency };

    // Wait for RDAP availability checks + CF pricing (started in parallel with browser)
    const [rdapAvail, cfTldPrices] = await Promise.all([rdapPromise, cfPricesPromise]);

    // Build main domain availability from RDAP + GoDaddy exact + Cloudflare pricing
    {
      const emd = searchExact?.ExactMatchDomain;
      const p = searchExact?.Products?.[0];
      // RDAP is authoritative for availability
      const rdapMain = queriedTld ? rdapAvail[queriedTld] : null;
      // Fallback chain: RDAP → ExactMatchDomain → ProductId heuristic
      const isAvailable = rdapMain !== null
        ? rdapMain === true
        : emd
          ? emd.IsAvailable === true
          : (p ? (p.ProductId > 0 && !!p.PriceInfo?.CurrentPriceDisplay) : false);
      const cfMain = queriedTld ? cfTldPrices[queriedTld] : null;
      result.availability = {
        available: isAvailable,
        tld: queriedTld || (p?.Tld ?? null),
        price: cfMain?.registration ?? null,
        price_display: cfMain ? `$${cfMain.registration.toFixed(2)}` : null,
        renewal_price: cfMain?.renewal ?? null,
      };
    }

    // Build alternatives using Cloudflare wholesale pricing
    result.alternative_tlds = buildAlternatives(sld, altTlds, prioTlds, rdapAvail, cfTldPrices);

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Serve UI
    if (path === "/") {
      const cfCountry = (request.cf as any)?.country as string | undefined;
      const detectedMarket = (cfCountry && COUNTRY_TO_MARKET[cfCountry]) || DEFAULT_MARKET;
      const prioTlds = priorityTldsForMarket(detectedMarket);
      const inject = `<script>window.__DETECTED_MARKET=${JSON.stringify(detectedMarket)};window.__PRIO_TLDS=${JSON.stringify(prioTlds)};</script>`;
      const html = HTML_UI.replace("</head>", inject + "</head>");
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }

    // Health check
    if (path === "/health") {
      return Response.json(
        {
          status: "ok",
          appraisal_enabled: APPRAISAL_ENABLED,
          cache_size: cache.size,
          default_market: DEFAULT_MARKET,
          available_markets: Object.keys(MARKETS),
        },
        { headers: corsHeaders }
      );
    }

    // Internal fan-out endpoint: RDAP-check a chunk of TLDs for one SLD.
    // Called by fetchAvailability via the SELF binding so the full sweep
    // stays under the per-invocation subrequest cap.
    if (path === "/rdap-batch") {
      const sld = (url.searchParams.get("sld") || "").toLowerCase().trim();
      const tlds = (url.searchParams.get("tlds") || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 45);
      if (!sld || !tlds.length) {
        return Response.json(
          { error: "sld and tlds required" },
          { status: 400, headers: corsHeaders }
        );
      }
      const results = await checkAllRdap(sld, tlds);
      return Response.json(results, { headers: corsHeaders });
    }

    // Parse market from query string (default: mx)
    const marketParam = (url.searchParams.get("market") || DEFAULT_MARKET).toLowerCase();
    const market = MARKETS[marketParam] ? marketParam : DEFAULT_MARKET;

    // Single domain appraisal: /appraisal/example.com?market=us
    const appraisalMatch = path.match(/^\/appraisal\/(.+)$/);
    if (appraisalMatch) {
      const domain = appraisalMatch[1].toLowerCase().trim();

      if (!domain || !domain.includes(".")) {
        return Response.json(
          { error: "Invalid domain. Example: /appraisal/example.com" },
          { status: 400, headers: corsHeaders }
        );
      }

      try {
        const result = APPRAISAL_ENABLED
          ? await fetchAppraisal(env, domain, market)
          : await fetchAvailability(env, domain, market);
        if (!result._cached) {
          const bestAlt = result.alternative_tlds?.find((t: any) => t.available && t.price_display);
          // Store only available alternatives (capped) — the full sweep
          // returns ~400 entries, too much to keep per history row
          const availAlts = (result.alternative_tlds || []).filter((t: any) => t.available).slice(0, 40);
          const altsJson = availAlts.length
            ? JSON.stringify(availAlts.map((t: any) => ({
                d: t.domain, t: t.tld, a: 1,
                p: t.price_display || null,
              })))
            : null;
          ctx.waitUntil(
            env.DB.prepare(
              `INSERT INTO searches (domain, govalue, available, price_display, market, currency, best_alt_tld, best_alt_price, alts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              result.domain,
              result.govalue || null,
              result.availability?.available ? 1 : 0,
              result.availability?.price_display || null,
              result.market,
              result.currency,
              bestAlt?.domain || null,
              bestAlt?.price_display || null,
              altsJson,
            ).run().catch(() => {})
          );
        }
        return Response.json(result, { headers: corsHeaders });
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Failed to fetch appraisal" },
          { status: 502, headers: corsHeaders }
        );
      }
    }

    // Batch: /batch?domains=a.com,b.com
    if (path === "/batch") {
      const domainsParam = url.searchParams.get("domains");
      if (!domainsParam) {
        return Response.json(
          { error: "Missing ?domains= parameter" },
          { status: 400, headers: corsHeaders }
        );
      }

      const domains = domainsParam
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.includes("."))
        .slice(0, 5);

      const results: Record<string, any> = {};
      for (const domain of domains) {
        try {
          results[domain] = APPRAISAL_ENABLED
            ? await fetchAppraisal(env, domain, market)
            : await fetchAvailability(env, domain, market, "popular");
        } catch (err: any) {
          results[domain] = { error: err.message };
        }
      }

      return Response.json(results, { headers: corsHeaders });
    }

    // Search history
    if (path === "/history") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const { results } = await env.DB.prepare(
        `SELECT * FROM searches ORDER BY searched_at DESC LIMIT ?`
      ).bind(limit).all();
      return Response.json(results, { headers: corsHeaders });
    }

    return Response.json(
      {
        error: "Not found",
        usage: {
          single: "/appraisal/example.com",
          with_market: "/appraisal/example.com?market=us",
          batch: "/batch?domains=a.com,b.com&market=mx",
          health: "/health",
          markets: Object.keys(MARKETS),
        },
      },
      { status: 404, headers: corsHeaders }
    );
  },
};
