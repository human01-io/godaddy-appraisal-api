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

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Domain Appraisal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a12;--bg2:#111119;--bg3:#191924;--border:#222233;
  --text:#e8e8f0;--text2:#8888a0;--text3:#555568;
  --accent:#10b981;--accent-bg:rgba(16,185,129,0.08);
  --gold:#f59e0b;--gold-bg:rgba(245,158,11,0.08);
  --indigo:#818cf8;--indigo-bg:rgba(129,140,248,0.08);
  --red:#f87171;--green:#34d399;
}
html{font-size:16px}
body{
  font-family:'Outfit',sans-serif;background:var(--bg);color:var(--text);
  min-height:100vh;-webkit-font-smoothing:antialiased;
}
body::after{
  content:'';position:fixed;top:-50%;left:-50%;right:-50%;bottom:-50%;
  background:radial-gradient(ellipse at 50% 0%,rgba(99,102,241,0.07) 0%,transparent 60%),
             radial-gradient(ellipse at 80% 50%,rgba(16,185,129,0.04) 0%,transparent 50%);
  pointer-events:none;z-index:0;
}
#app{position:relative;z-index:1;max-width:960px;margin:0 auto;padding:0 24px 60px}
header{padding:32px 0 20px;display:flex;align-items:center}
.logo{
  font-size:0.78rem;font-weight:700;letter-spacing:0.12em;
  color:var(--accent);text-transform:uppercase;
}
.logo span{color:var(--text3);font-weight:400;margin-left:4px}
.hero-text{
  text-align:center;font-size:2.6rem;font-weight:800;line-height:1.15;
  letter-spacing:-0.03em;margin:40px 0 36px;
  background:linear-gradient(135deg,var(--text) 0%,var(--text2) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.search-form{max-width:640px;margin:0 auto}
.search-wrapper{
  display:flex;gap:8px;background:var(--bg2);border:1px solid var(--border);
  border-radius:16px;padding:6px;transition:border-color 0.3s,box-shadow 0.3s;
}
.search-wrapper:focus-within{
  border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-bg),0 8px 32px rgba(0,0,0,0.3);
}
.search-wrapper input{
  flex:1;min-width:0;background:none;border:none;color:var(--text);
  font-family:'JetBrains Mono',monospace;font-size:1.05rem;
  padding:12px 16px;outline:none;
}
.search-wrapper input::placeholder{color:var(--text3)}
.search-wrapper select{
  background:var(--bg3);border:1px solid var(--border);border-radius:10px;
  color:var(--text);font-family:'Outfit',sans-serif;font-size:0.85rem;
  padding:8px 12px;cursor:pointer;outline:none;-webkit-appearance:none;
}
.search-wrapper button{
  background:var(--accent);border:none;border-radius:10px;color:#000;
  font-family:'Outfit',sans-serif;font-weight:600;font-size:0.9rem;
  padding:12px 24px;cursor:pointer;display:flex;align-items:center;gap:6px;
  transition:opacity 0.2s;white-space:nowrap;
}
.search-wrapper button:hover{opacity:0.85}
.search-wrapper button:disabled{opacity:0.5;cursor:not-allowed}
.search-wrapper button svg{width:16px;height:16px}
.hidden{display:none!important}
#loading{text-align:center;padding:80px 0}
.loading-card{
  display:inline-block;background:var(--bg2);border:1px solid var(--border);
  border-radius:20px;padding:48px 64px;
}
.loading-spinner{
  width:44px;height:44px;border:3px solid var(--border);border-top-color:var(--accent);
  border-radius:50%;margin:0 auto 24px;animation:spin 0.8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-text{font-size:1.1rem;font-weight:500;margin-bottom:8px}
.loading-text span{font-family:'JetBrains Mono',monospace;color:var(--accent)}
.loading-sub{color:var(--text3);font-size:0.85rem;margin-bottom:24px}
.progress-bar{
  width:220px;height:3px;background:var(--bg3);border-radius:2px;
  margin:0 auto 12px;overflow:hidden;
}
.progress-fill{height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width 0.4s linear}
.elapsed{font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--text3)}
.error-card{
  max-width:420px;margin:60px auto;background:var(--bg2);
  border:1px solid rgba(248,113,113,0.2);border-radius:16px;padding:40px;text-align:center;
}
.error-icon{
  width:48px;height:48px;line-height:48px;border-radius:50%;
  background:rgba(248,113,113,0.1);color:var(--red);
  font-size:1.4rem;font-weight:700;margin:0 auto 16px;
}
.error-text{color:var(--text2);margin-bottom:24px;font-size:0.95rem;word-break:break-word}
.error-card button{
  background:var(--bg3);border:1px solid var(--border);border-radius:8px;
  color:var(--text);font-family:'Outfit',sans-serif;font-size:0.85rem;
  padding:10px 20px;cursor:pointer;transition:border-color 0.2s;
}
.error-card button:hover{border-color:var(--text3)}
.result-hero{
  background:var(--bg2);border:1px solid var(--border);border-radius:20px;
  padding:40px;margin-top:48px;margin-bottom:24px;
}
.result-hero-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;gap:12px;flex-wrap:wrap}
.result-domain{font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:600}
.badge{
  display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:100px;
  font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;flex-shrink:0;
}
.badge-available{background:rgba(52,211,153,0.1);color:var(--green);border:1px solid rgba(52,211,153,0.2)}
.badge-taken{background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2)}
.badge-aftermarket{background:rgba(251,191,36,0.1);color:#fbbf24;border:1px solid rgba(251,191,36,0.2)}
.badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.govalue-label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-bottom:8px}
.govalue-amount{
  font-family:'JetBrains Mono',monospace;font-size:3.2rem;font-weight:700;
  color:var(--gold);line-height:1;
}
.govalue-reg{font-family:'JetBrains Mono',monospace;font-size:0.9rem;color:var(--text2);margin-top:10px}
.govalue-reg s{color:var(--text3);margin-left:8px;font-size:0.85rem}
.reasons{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px;padding-top:24px;border-top:1px solid var(--border)}
.reason-tag{
  display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px;
  background:var(--bg3);border:1px solid var(--border);font-size:0.8rem;color:var(--text2);
}
.reason-tag .ri{font-size:0.7rem;opacity:0.6}
.section-title{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-bottom:16px}
.tld-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:10px;margin-bottom:24px}
.tld-card{
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  padding:16px;transition:border-color 0.2s,transform 0.2s;cursor:default;
}
.tld-card:hover{transform:translateY(-2px);border-color:var(--text3)}
.tld-card.priority{border-color:rgba(129,140,248,0.3);background:var(--indigo-bg)}
.tld-card.priority:hover{border-color:var(--indigo)}
.tld-domain{
  font-family:'JetBrains Mono',monospace;font-size:0.88rem;font-weight:500;
  margin-bottom:8px;display:flex;align-items:center;gap:6px;
}
.tld-card.priority .tld-domain{color:var(--indigo)}
.priority-star{font-size:0.6rem;color:var(--indigo)}
.tld-price{font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--text2);margin-bottom:4px}
.tld-status{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em}
.tld-status.available{color:var(--green)}
.tld-status.aftermarket{color:#fbbf24}
.tld-status.taken{color:var(--red)}
.sales-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:40px}
.sale-card{
  background:var(--bg2);border:1px solid var(--border);border-radius:12px;
  padding:14px 16px;display:flex;justify-content:space-between;align-items:center;
}
.sale-domain{font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--text)}
.sale-info{text-align:right}
.sale-price{font-family:'JetBrains Mono',monospace;font-size:0.82rem;color:var(--gold);font-weight:500}
.sale-year{font-size:0.7rem;color:var(--text3)}
.footer{text-align:center;padding:40px 0 20px;color:var(--text3);font-size:0.75rem}
.footer a{color:var(--text2);text-decoration:none}
.footer a:hover{color:var(--accent)}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.anim{animation:fadeUp 0.5s ease-out both}
@media(max-width:640px){
  .hero-text{font-size:1.7rem;margin:30px 0 28px}
  .search-wrapper{flex-wrap:wrap}
  .search-wrapper input{min-width:100%}
  .search-wrapper select,.search-wrapper button{flex:1}
  .govalue-amount{font-size:2.4rem}
  .result-hero{padding:24px}
  .tld-grid{grid-template-columns:repeat(2,1fr)}
  .sales-grid{grid-template-columns:1fr}
  .loading-card{padding:36px 28px}
}
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo">DOMAIN APPRAISAL <span>API</span></div>
  </header>

  <h2 class="hero-text" id="heroText">Discover the value<br>of any domain</h2>

  <form id="searchForm" class="search-form">
    <div class="search-wrapper">
      <input id="domainInput" type="text" placeholder="example.com" autocomplete="off" spellcheck="false" required>
      <select id="marketSelect"></select>
      <button type="submit" id="submitBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        Appraise
      </button>
    </div>
  </form>

  <div id="loading" class="hidden">
    <div class="loading-card">
      <div class="loading-spinner"></div>
      <div class="loading-text">Analyzing <span id="loadingDomain"></span></div>
      <div class="loading-sub">This typically takes 5-10 seconds</div>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="elapsed" id="elapsed">0s</div>
    </div>
  </div>

  <div id="error" class="hidden">
    <div class="error-card">
      <div class="error-icon">!</div>
      <div class="error-text" id="errorText"></div>
      <button onclick="document.getElementById('error').classList.add('hidden');document.getElementById('domainInput').focus()">Try Again</button>
    </div>
  </div>

  <div id="results" class="hidden"></div>

  <div class="footer">Powered by Cloudflare Workers + Browser Rendering</div>
</div>

<script>
(function(){
  var form=document.getElementById('searchForm');
  var input=document.getElementById('domainInput');
  var mktSel=document.getElementById('marketSelect');
  var loadEl=document.getElementById('loading');
  var resEl=document.getElementById('results');
  var errEl=document.getElementById('error');
  var btn=document.getElementById('submitBtn');
  var timer=null;

  var mkts=[
    ['mx','MX - MXN'],['us','US - USD'],['uk','UK - GBP'],['ca','CA - CAD'],
    ['au','AU - AUD'],['br','BR - BRL'],['de','DE - EUR'],['fr','FR - EUR'],
    ['es','ES - EUR'],['it','IT - EUR'],['jp','JP - JPY'],['in','IN - INR'],
    ['sg','SG - SGD'],['co','CO - COP'],['ar','AR - ARS'],['cl','CL - CLP']
  ];
  mkts.forEach(function(m){
    var o=document.createElement('option');
    o.value=m[0];o.textContent=m[1];
    if(m[0]==='mx')o.selected=true;
    mktSel.appendChild(o);
  });

  form.addEventListener('submit',function(e){
    e.preventDefault();
    var d=input.value.trim().toLowerCase();
    if(!d)return;
    if(d.indexOf('.')===-1)d=d+'.com';
    run(d,mktSel.value);
  });

  function run(domain,market){
    errEl.classList.add('hidden');
    resEl.classList.add('hidden');
    loadEl.classList.remove('hidden');
    btn.disabled=true;
    document.getElementById('loadingDomain').textContent=domain;
    var pf=document.getElementById('progressFill');
    var el=document.getElementById('elapsed');
    pf.style.width='0%';
    var t0=Date.now();
    clearInterval(timer);
    timer=setInterval(function(){
      var s=((Date.now()-t0)/1000)|0;
      el.textContent=s+'s elapsed';
      var pct=Math.min((Date.now()-t0)/12000*100,95);
      pf.style.width=pct+'%';
    },250);

    fetch('/appraisal/'+encodeURIComponent(domain)+'?market='+market)
      .then(function(r){return r.json()})
      .then(function(data){
        stop();
        if(data.error){showErr(data.error)}
        else{render(data)}
      })
      .catch(function(e){stop();showErr(e.message||'Network error')});
  }

  function stop(){clearInterval(timer);loadEl.classList.add('hidden');btn.disabled=false}
  function showErr(msg){document.getElementById('errorText').textContent=msg;errEl.classList.remove('hidden')}

  function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}
  function fmtNum(n){return Number(n).toLocaleString()}

  function render(d){
    var pr=['mx','io','app','ai'];
    var h='';

    h+='<div class="result-hero anim">';
    h+='<div class="result-hero-top"><div class="result-domain">'+esc(d.domain)+'</div>';
    if(d.availability){
      if(d.availability.available){
        h+='<div class="badge badge-available"><span class="badge-dot"></span>Available</div>';
      }else if(d.availability.buyable){
        h+='<div class="badge badge-aftermarket"><span class="badge-dot"></span>Aftermarket</div>';
      }else{
        h+='<div class="badge badge-taken"><span class="badge-dot"></span>Taken</div>';
      }
    }
    h+='</div>';

    h+='<div class="govalue-label">Estimated Value (GoValue)</div>';
    h+='<div class="govalue-amount" id="goval" data-v="'+(d.govalue||0)+'">$0</div>';

    if(d.availability&&d.availability.price_display){
      h+='<div class="govalue-reg">Registration: '+esc(d.availability.price_display);
      if(d.availability.list_price&&d.availability.list_price!==d.availability.price){
        h+=' <s>'+esc(d.currency)+fmtNum(d.availability.list_price)+'</s>';
      }
      h+='</div>';
    }

    if(d.reasons&&d.reasons.length){
      h+='<div class="reasons">';
      d.reasons.forEach(function(r){
        h+='<div class="reason-tag"><span class="ri">'+rIcon(r.type)+'</span> '+esc(rText(r))+'</div>';
      });
      h+='</div>';
    }
    h+='</div>';

    if(d.alternative_tlds&&d.alternative_tlds.length){
      h+='<div class="anim" style="animation-delay:0.1s">';
      h+='<div class="section-title">Alternative TLDs</div><div class="tld-grid">';
      d.alternative_tlds.forEach(function(t){
        var ip=pr.indexOf(t.tld)!==-1;
        h+='<div class="tld-card'+(ip?' priority':'')+'">';
        h+='<div class="tld-domain">'+esc(t.domain)+(ip?' <span class="priority-star">&#9733;</span>':'')+'</div>';
        if(t.price_display)h+='<div class="tld-price">'+esc(t.price_display)+'</div>';
        var st=t.available?'available':(t.buyable?'aftermarket':'taken');
        var sl=t.available?'Available':(t.buyable?'Aftermarket':'Taken');
        h+='<div class="tld-status '+st+'">'+sl+'</div>';
        h+='</div>';
      });
      h+='</div></div>';
    }

    if(d.comparable_sales&&d.comparable_sales.length){
      h+='<div class="anim" style="animation-delay:0.2s">';
      h+='<div class="section-title">Comparable Sales</div><div class="sales-grid">';
      d.comparable_sales.forEach(function(s){
        h+='<div class="sale-card"><div class="sale-domain">'+esc(s.domain)+'</div>';
        h+='<div class="sale-info"><div class="sale-price">$'+fmtNum(s.price)+'</div>';
        h+='<div class="sale-year">'+s.year+'</div></div></div>';
      });
      h+='</div></div>';
    }

    resEl.innerHTML=h;
    resEl.classList.remove('hidden');
    resEl.scrollIntoView({behavior:'smooth',block:'start'});

    var gEl=document.getElementById('goval');
    if(gEl){countUp(gEl,0,parseInt(gEl.getAttribute('data-v'))||0,1200)}
  }

  function countUp(el,from,to,dur){
    var t0=null;
    function step(ts){
      if(!t0)t0=ts;
      var p=Math.min((ts-t0)/dur,1);
      var e=1-Math.pow(1-p,3);
      el.textContent='$'+Math.floor(from+(to-from)*e).toLocaleString();
      if(p<1)requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function rText(r){
    switch(r.type){
      case 'memorable':return 'Memorable name';
      case 'broad_appeal':return 'Broad commercial appeal';
      case 'other_extension_sold_high':return esc(r.domain)+' sold for $'+fmtNum(r.price);
      case 'great_extension':return 'Premium extension';
      case 'short':return 'Short & concise';
      case 'valuable_keyword':return '"'+r.keyword+'" keyword (avg $'+fmtNum(r.avg_sold_price)+')';
      case 'popular_keyword':return '"'+r.keyword+'" is popular';
      default:return r.type.replace(/_/g,' ');
    }
  }
  function rIcon(t){
    switch(t){
      case 'memorable':return '&#9830;';case 'broad_appeal':return '&#9733;';
      case 'other_extension_sold_high':return '&#36;';case 'great_extension':return '&#9733;';
      case 'short':return '&#8596;';case 'valuable_keyword':return '&#9670;';
      case 'popular_keyword':return '&#8593;';default:return '&#8226;';
    }
  }

  input.focus();
})();
</script>
</body>
</html>`;

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

    // Navigate to GoDaddy appraisal page — domcontentloaded is enough to establish session
    let apiData: { status: number; body: any } | null = null;

    // Set up response interception to catch the appraisal call if the page makes it
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

    // Appraisal succeeded — now fetch availability + alternative TLDs
    // All calls run in parallel for speed
    const searchResults = await page.evaluate(`
      (async () => {
        var domain = ${JSON.stringify(domain)};
        var host = window.location.origin;
        var results = { exact: null, spins: null, priority: [], errors: [] };

        function doFetch(url) {
          return fetch(url, {
            headers: { "Accept": "application/json" },
            credentials: "include",
          }).then(function(r) {
            if (!r.ok) throw new Error(r.status + " " + r.statusText);
            return r.json();
          });
        }

        var h = host;
        var sld = domain.split(".")[0];
        var priorityTlds = ["mx", "io", "app", "ai"];

        // Fire exact + spins in parallel
        var settled = await Promise.allSettled([
          doFetch(h + "/domainfind/v1/search/exact?key=appraisals_search&q=" + encodeURIComponent(domain)),
          doFetch(h + "/domainfind/v1/search/spins?key=appraisals_search&q=" + encodeURIComponent(domain) + "&pagesize=20&tlds=mx,io,app,ai,com,net,org,co,dev,xyz,shop,store")
        ]);

        if (settled[0].status === "fulfilled") results.exact = settled[0].value;
        else results.errors.push("exact: " + settled[0].reason);
        if (settled[1].status === "fulfilled") results.spins = settled[1].value;
        else results.errors.push("spins: " + settled[1].reason);

        // Find which priority TLDs are missing from spins, then fetch them in parallel
        var spinsHasTld = {};
        if (results.spins && results.spins.Products) {
          results.spins.Products.forEach(function(p) { spinsHasTld[p.Tld] = true; });
        }
        var missingTlds = priorityTlds.filter(function(t) { return !spinsHasTld[t]; });

        if (missingTlds.length > 0) {
          var pSettled = await Promise.allSettled(
            missingTlds.map(function(tld) {
              return doFetch(h + "/domainfind/v1/search/exact?key=appraisals_search&q=" + encodeURIComponent(sld + "." + tld));
            })
          );
          pSettled.forEach(function(r) {
            if (r.status === "fulfilled" && r.value && r.value.Products && r.value.Products.length > 0) {
              results.priority.push(r.value.Products[0]);
            }
          });
        }

        return results;
      })()
    `) as any;

    // Stop all page activity immediately — we have everything we need
    await page.evaluate("window.stop()").catch(() => {});

    const searchExact = searchResults?.exact;
    const searchSpins = searchResults?.spins;

    // Build enriched result
    const result: any = { ...apiData.body, market: marketKey, currency: mkt.currency };

    if (searchExact?.Products?.[0]) {
      const p = searchExact.Products[0];
      result.availability = {
        available: p.Available === true,
        buyable: p.Buyable === true,
        purchase_type: p.PurchaseType ?? null,
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
          available: p.Available === true,
          buyable: p.Buyable === true,
          purchase_type: p.PurchaseType ?? null,
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

    // Serve UI
    if (path === "/") {
      return new Response(HTML_UI, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }

    // Health check
    if (path === "/health") {
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

      try {
        const result = await fetchAppraisal(env, domain, market);
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
