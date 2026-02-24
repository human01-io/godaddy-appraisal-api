import puppeteer, { Browser } from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
  CACHE_TTL: string;
}

// In-memory cache (per isolate, resets on cold start)
const cache = new Map<string, { data: any; ts: number }>();

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

async function fetchAppraisal(
  env: Env,
  domain: string,
  marketKey: string = DEFAULT_MARKET,
): Promise<any> {
  const cacheTtl = parseInt(env.CACHE_TTL || "3600");
  const cacheKey = `${domain}:${marketKey}`;
  const mkt = MARKETS[marketKey] || MARKETS[DEFAULT_MARKET];

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cacheTtl * 1000) {
    return { ...cached.data, _cached: true };
  }

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

    // Set market cookies so GoDaddy returns region-specific TLD suggestions
    await page.setCookie(
      { name: "market", value: mkt.market, domain: ".godaddy.com" },
      { name: "currency", value: mkt.currency, domain: ".godaddy.com" },
    );

    // Intercept the appraisal API response from the page
    let apiData: { status: number; body: any } | null = null;
    const apiPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 25000);
      page.on("response", async (response) => {
        if (response.url().includes("api.godaddy.com/v1/appraisal/")) {
          try {
            const body = await response.json();
            apiData = { status: response.status(), body };
          } catch {
            apiData = { status: response.status(), body: null };
          }
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Navigate to GoDaddy appraisal page using the selected market subdomain
    const targetUrl = `https://${mkt.subdomain}.godaddy.com/domain-value-appraisal/appraisal/?domainToCheck=${encodeURIComponent(domain)}`;
    await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {
      // networkidle0 may timeout on heavy pages — that's ok
    });

    // Extra wait if needed
    if (!apiData) {
      await new Promise((r) => setTimeout(r, 5000));
    }

    await apiPromise;

    // Fallback: fetch appraisal directly from page context
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

    // Appraisal succeeded — now fetch availability + alternative TLDs
    // from the page context (uses the browser's cookies/session)
    const searchResults = await page.evaluate(`
      (async () => {
        const domain = ${JSON.stringify(domain)};
        const host = window.location.origin;
        const results = { exact: null, spins: null, host: host, errors: [] };

        async function doFetch(url) {
          const r = await fetch(url, {
            headers: { "Accept": "application/json" },
            credentials: "include",
          });
          if (!r.ok) throw new Error(r.status + " " + r.statusText);
          return await r.json();
        }

        const hosts = [host];
        if (host !== "https://www.godaddy.com") hosts.push("https://www.godaddy.com");

        var sld = domain.split(".")[0];
        var priorityTlds = ["mx", "io", "app", "ai"];

        for (const h of hosts) {
          try {
            if (!results.exact) {
              results.exact = await doFetch(
                h + "/domainfind/v1/search/exact?key=appraisals_search&q=" + encodeURIComponent(domain)
              );
            }
          } catch (e) {
            results.errors.push("exact@" + h + ": " + e.message);
          }

          try {
            if (!results.spins) {
              results.spins = await doFetch(
                h + "/domainfind/v1/search/spins?key=appraisals_search&q=" + encodeURIComponent(domain) + "&pagesize=20&tlds=mx,io,app,ai,com,net,org,co,dev,xyz,shop,store"
              );
            }
          } catch (e) {
            results.errors.push("spins@" + h + ": " + e.message);
          }

          // Explicitly check each priority TLD that's missing from spins
          if (!results.priority) results.priority = [];
          var spinsHasTld = {};
          if (results.spins && results.spins.Products) {
            results.spins.Products.forEach(function(p) { spinsHasTld[p.Tld] = true; });
          }

          for (var i = 0; i < priorityTlds.length; i++) {
            var tld = priorityTlds[i];
            if (spinsHasTld[tld]) continue;
            try {
              var priorityResult = await doFetch(
                h + "/domainfind/v1/search/exact?key=appraisals_search&q=" + encodeURIComponent(sld + "." + tld)
              );
              if (priorityResult && priorityResult.Products && priorityResult.Products.length > 0) {
                results.priority.push(priorityResult.Products[0]);
              }
            } catch (e) {
              results.errors.push("priority_" + tld + "@" + h + ": " + e.message);
            }
          }

          if (results.exact && results.spins) break;
        }

        return results;
      })()
    `) as any;

    const searchExact = searchResults?.exact;
    const searchSpins = searchResults?.spins;

    // Build enriched result
    const result: any = { ...apiData.body, market: marketKey, currency: mkt.currency };

    if (searchExact?.Products?.[0]) {
      const p = searchExact.Products[0];
      result.availability = {
        available: p.Buyable !== false,
        tld: p.Tld,
        price: p.PriceInfo?.CurrentPrice ?? null,
        price_display: p.PriceInfo?.CurrentPriceDisplay ?? null,
        list_price: p.PriceInfo?.ListPrice ?? null,
        is_promo: p.PriceInfo?.IsPromoDiscount ?? false,
        icann_fee: p.HasIcannFee ?? false,
      };
    }

    {
      const sld = domain.split(".")[0];
      const priorityTldOrder = ["mx", "io", "app", "ai"];
      const seenTlds = new Set<string>();
      const allProducts: any[] = [];

      // Add priority TLD results (from explicit exact lookups)
      if (searchResults?.priority?.length) {
        for (const p of searchResults.priority) {
          if (!seenTlds.has(p.Tld)) {
            allProducts.push(p);
            seenTlds.add(p.Tld);
          }
        }
      }

      // Add spins results
      if (searchSpins?.Products?.length) {
        for (const p of searchSpins.Products) {
          if (!seenTlds.has(p.Tld)) {
            allProducts.push(p);
            seenTlds.add(p.Tld);
          }
        }
      }

      if (allProducts.length) {
        const mapped = allProducts.map((p: any) => ({
          domain: `${sld}.${p.Tld}`,
          tld: p.Tld,
          available: p.Buyable !== false,
          price: p.PriceInfo?.CurrentPrice ?? null,
          price_display: p.PriceInfo?.CurrentPriceDisplay ?? null,
          list_price: p.PriceInfo?.ListPrice ?? null,
        }));

        // Sort: priority TLDs first (in order), then the rest
        mapped.sort((a: any, b: any) => {
          const aIdx = priorityTldOrder.indexOf(a.tld);
          const bIdx = priorityTldOrder.indexOf(b.tld);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return 0;
        });

        result.alternative_tlds = mapped;
      }
    }

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json(
        {
          status: "ok",
          cache_size: cache.size,
          default_market: DEFAULT_MARKET,
          available_markets: Object.keys(MARKETS),
        },
        { headers: corsHeaders }
      );
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

      // Retry up to 2 times on rate limit
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await fetchAppraisal(env, domain, market);
          return Response.json(result, { headers: corsHeaders });
        } catch (err: any) {
          if (err.message === "RATE_LIMITED" && attempt < 1) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          return Response.json(
            { error: err.message || "Failed to fetch appraisal" },
            { status: 502, headers: corsHeaders }
          );
        }
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
          results[domain] = await fetchAppraisal(env, domain, market);
        } catch (err: any) {
          results[domain] = { error: err.message };
        }
      }

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
