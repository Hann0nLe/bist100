import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const UI_FILE = join(__dirname, 'public', 'index.html');

const CURRENT_URL = 'https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/default.aspx';
const FUND_URL = 'https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/Temel-Degerler-Ve-Oranlar.aspx';
const SCREENER_URL = 'https://www.isyatirim.com.tr/tr-tr/analiz/_Layouts/15/IsYatirim.Website/StockInfo/CompanyInfoAjax.aspx/getScreenerDataNEW';
const INVESTING_SEARCH_URL = 'https://www.investing.com/search/service/searchTopBar';

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 22_000;

const state = {
  phase: 'starting',
  message: 'Gerçek BIST verisi hazırlanıyor',
  generatedAt: null,
  stocks: [],
  errors: [],
};

const now = () => new Date().toISOString();
const normalizeTicker = (v) => String(v ?? '').trim().toLocaleUpperCase('tr-TR').replace(/[^A-Z0-9]/g, '');
const isTicker = (v) => /^[A-Z0-9]{3,7}$/.test(v);
const num = (v) => {
  if (v == null) return null;
  let s = String(v).trim().replace(/\u00a0/g, ' ').replace(/[^\d,.-]/g, '');
  if (!s || s === '-') return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function decodeHtml(v) {
  const named = { amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', nbsp:' ', ccedil:'ç', Ccedil:'Ç', gbreve:'ğ', Gbreve:'Ğ', Idot:'İ', imath:'ı', odot:'ö', Odot:'Ö', scedil:'ş', Scedil:'Ş', uuml:'ü', Uuml:'Ü' };
  return String(v ?? '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => Object.hasOwn(named, n) ? named[n] : m);
}
function stripHtml(v) {
  return decodeHtml(String(v ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|td|th|tr|a|span|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n').trim());
}
function tableRows(html) {
  return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m =>
    [...m[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map(c => stripHtml(c[1]).replace(/\s+/g, ' ').trim())
  );
}
function findRows(html, required) {
  const req = required.map(x => x.toLocaleUpperCase('tr-TR'));
  for (const t of [...String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]) {
    const text = stripHtml(t[0]).toLocaleUpperCase('tr-TR');
    if (req.every(x => text.includes(x))) return tableRows(t[0]);
  }
  throw new Error(`Tablo bulunamadı: ${required.join(' / ')}`);
}

async function fetchRetry(url, options = {}, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          'Accept': 'text/html,application/json,text/plain,*/*',
          ...(options.headers || {}),
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return r;
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise(res => setTimeout(res, 700 * i));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

async function fetchScreener() {
  const r = await fetchRetry(SCREENER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.isyatirim.com.tr/tr-tr/analiz/hisse/Sayfalar/gelismis-hisse-arama.aspx',
    },
    body: JSON.stringify({
      sektor: '', endeks: '09', takip: '', oneri: '', lang: '1055',
      criterias: [
        ['7','0','100000','False'],
        ['8','0','100000000','False'],
        ['28','-1000','1000','False'],
      ],
    }),
  });
  const outer = await r.json();
  const rows = JSON.parse(outer.d || '[]');
  const map = new Map();
  for (const row of rows) {
    const [symbolPart, ...nameParts] = String(row.Hisse || '').split(' - ');
    const ticker = normalizeTicker(symbolPart);
    if (!isTicker(ticker)) continue;
    map.set(ticker, {
      ticker,
      name: nameParts.join(' - ').trim() || ticker,
      price: num(row['7']),
      marketCapMnTry: num(row['8']),
      pe: num(row['28']),
    });
  }
  return map;
}

function parseCurrent(html) {
  const rows = findRows(html, ['Son Fiyat', 'Değişim', 'Hacim']);
  const map = new Map();
  for (const cells of rows.slice(1)) {
    if (cells.length < 6) continue;
    const ticker = normalizeTicker(cells[0]);
    if (!isTicker(ticker)) continue;
    map.set(ticker, {
      price: num(cells[1]), d1: num(cells[2]),
      changeTry: num(cells[3]), volumeTry: num(cells[4]), volumeShares: num(cells[5]),
    });
  }
  return map;
}

function parseFundamentals(html) {
  const rows = findRows(html, ['Hisse Adı', 'Piyasa Değeri', 'Halka Açıklık']);
  const map = new Map();
  for (const cells of rows.slice(1)) {
    if (cells.length < 8) continue;
    const ticker = normalizeTicker(cells[0]);
    if (!isTicker(ticker)) continue;
    map.set(ticker, {
      name: cells[1] || ticker,
      sector: cells[2] || 'Diğer',
      price: num(cells[3]),
      marketCapMnTry: num(cells[4]),
      freeFloatPercent: num(cells[6]),
    });
  }
  return map;
}

async function refresh() {
  state.phase = 'loading';
  state.message = 'Gerçek BIST verisi güncelleniyor';
  try {
    const [currentRes, fundRes, screenerResult] = await Promise.allSettled([
      fetchRetry(CURRENT_URL).then(r => r.text()).then(parseCurrent),
      fetchRetry(FUND_URL).then(r => r.text()).then(parseFundamentals),
      fetchScreener(),
    ]);
    const current = currentRes.status === 'fulfilled' ? currentRes.value : new Map();
    const funds = fundRes.status === 'fulfilled' ? fundRes.value : new Map();
    const screener = screenerResult.status === 'fulfilled' ? screenerResult.value : new Map();
    const tickers = new Set([...current.keys(), ...funds.keys(), ...screener.keys()]);
    const stocks = [];
    for (const ticker of tickers) {
      const c = current.get(ticker) || {};
      const f = funds.get(ticker) || {};
      const s = screener.get(ticker) || {};
      const price = c.price ?? f.price ?? s.price ?? null;
      const marketCapMnTry = f.marketCapMnTry ?? s.marketCapMnTry ?? null;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(marketCapMnTry) || marketCapMnTry <= 0) continue;
      stocks.push({
        ticker,
        name: f.name || s.name || ticker,
        sector: f.sector || 'Diğer',
        subSector: f.sector || 'Genel',
        price,
        marketCap: marketCapMnTry / 1000,
        volume: Number.isFinite(c.volumeTry) ? c.volumeTry / 1_000_000 : 0,
        volumeShares: c.volumeShares ?? null,
        d1: c.d1 ?? null,
        pe: s.pe ?? null,
        freeFloatPercent: f.freeFloatPercent ?? null,
      });
    }
    stocks.sort((a,b) => b.marketCap - a.marketCap);
    if (!stocks.length) throw new Error('Kaynaklardan kullanılabilir hisse verisi alınamadı');
    state.stocks = stocks;
    state.generatedAt = now();
    state.phase = 'ready';
    state.message = `${stocks.length} hisse hazır`;
    state.errors = [];
    console.log(`[${state.generatedAt}] ${state.message}`);
  } catch (e) {
    const text = e?.message || String(e);
    state.phase = state.stocks.length ? 'stale' : 'error';
    state.message = text;
    state.errors = [...state.errors.slice(-9), text];
    console.error(`[${now()}] refresh error: ${text}`);
  }
}

function weightedChange(stocks) {
  let n=0,d=0;
  for (const s of stocks) if (Number.isFinite(s.d1) && s.marketCap > 0) { n += s.d1*s.marketCap; d += s.marketCap; }
  return d ? n/d : null;
}
function snapshot() {
  return {
    ready: Boolean(state.stocks.length), generatedAt: state.generatedAt, realData: true,
    delayed: true, refreshSeconds: REFRESH_MS/1000,
    source: { current: 'İş Yatırım Günlük Hisse Senedi Fiyatları', fundamentals: 'İş Yatırım Temel Değerler', screener: 'İş Yatırım Gelişmiş Hisse Arama' },
    coverage: { snapshotStocks: state.stocks.length, d1: state.stocks.length ? state.stocks.filter(s=>Number.isFinite(s.d1)).length/state.stocks.length : 0 },
    stocks: state.stocks,
  };
}
function status() { return { phase: state.phase, message: state.message, generatedAt: state.generatedAt, stockCount: state.stocks.length, errors: state.errors.slice(-5) }; }
function json(res, code, data) { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }

async function investingPair(ticker) {
  const r = await fetchRetry(INVESTING_SEARCH_URL, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest','Referer':'https://www.investing.com/'},
    body:new URLSearchParams({search_text:ticker}),
  });
  const payload = await r.json();
  const quotes = Array.isArray(payload?.quotes) ? payload.quotes : [];
  const matches = quotes.filter(q => normalizeTicker(q.symbol) === ticker && Number.isFinite(Number(q.pairId)));
  const preferred = matches.find(q => /istanbul|turkey|bist/i.test(`${q.exchange||''} ${q.exchange_name||''} ${q.country||''}`)) || matches[0];
  return preferred ? String(preferred.pairId) : '';
}

function mime(path) { const e=extname(path); return e==='.html'?'text/html; charset=utf-8':e==='.js'?'text/javascript; charset=utf-8':'application/octet-stream'; }
async function serveUI(res) { try { const b=await readFile(UI_FILE); res.writeHead(200,{'Content-Type':mime(UI_FILE),'Cache-Control':'no-store'}); res.end(b); } catch { res.writeHead(500); res.end('UI bulunamadı'); } }

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method==='GET' && (u.pathname==='/' || u.pathname==='/index.html')) return serveUI(res);
    if (req.method==='GET' && u.pathname==='/health') return json(res,200,{ok:true,phase:state.phase});
    if (req.method==='GET' && u.pathname==='/api/status') return json(res,200,status());
    if (req.method==='GET' && u.pathname==='/api/snapshot') return state.stocks.length ? json(res,200,snapshot()) : json(res,503,{ready:false,...status()});
    if (req.method==='GET' && u.pathname==='/api/market-summary') {
      if (!state.stocks.length) return json(res,503,{ready:false,...status()});
      const a=state.stocks.filter(s=>s.d1>0).length, d=state.stocks.filter(s=>s.d1<0).length, z=state.stocks.filter(s=>s.d1===0).length;
      return json(res,200,{generatedAt:state.generatedAt,stockCount:state.stocks.length,advancers:a,decliners:d,unchanged:z,marketCapWeightedChange:weightedChange(state.stocks)});
    }
    if (req.method==='GET' && u.pathname==='/api/sectors') {
      if (!state.stocks.length) return json(res,503,{ready:false,...status()});
      const m=new Map();
      for (const s of state.stocks) { const arr=m.get(s.sector)||[]; arr.push(s); m.set(s.sector,arr); }
      const sectors=[...m].map(([sector,stocks])=>({sector,stockCount:stocks.length,marketCap:stocks.reduce((x,s)=>x+s.marketCap,0),volume:stocks.reduce((x,s)=>x+(s.volume||0),0),d1:weightedChange(stocks)})).sort((a,b)=>b.marketCap-a.marketCap);
      return json(res,200,{generatedAt:state.generatedAt,count:sectors.length,sectors});
    }
    if (req.method==='GET' && u.pathname==='/api/stocks') {
      if (!state.stocks.length) return json(res,503,{ready:false,...status()});
      const q=(u.searchParams.get('q')||'').trim().toLocaleLowerCase('tr-TR');
      const sector=(u.searchParams.get('sector')||'').trim();
      const rows=state.stocks.filter(s=>(!sector||s.sector===sector)&&(!q||s.ticker.toLocaleLowerCase('tr-TR').includes(q)||s.name.toLocaleLowerCase('tr-TR').includes(q)));
      return json(res,200,{generatedAt:state.generatedAt,count:rows.length,stocks:rows});
    }
    if (req.method==='GET' && u.pathname.startsWith('/api/stocks/')) {
      const ticker=normalizeTicker(decodeURIComponent(u.pathname.slice('/api/stocks/'.length)));
      const stock=state.stocks.find(s=>s.ticker===ticker);
      return stock ? json(res,200,{generatedAt:state.generatedAt,stock}) : json(res,404,{error:'Hisse bulunamadı',ticker});
    }
    if (req.method==='GET' && u.pathname==='/api/investing-pair') {
      const ticker=normalizeTicker(u.searchParams.get('ticker'));
      if (!isTicker(ticker)) return json(res,400,{error:'Geçersiz ticker'});
      try { const pairId=await investingPair(ticker); return json(res,pairId?200:404,{ticker,pairId}); }
      catch(e) { return json(res,502,{ticker,pairId:'',error:e?.message||String(e)}); }
    }
    res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found');
  } catch(e) { json(res,500,{error:e?.message||String(e)}); }
});

server.listen(PORT,HOST,()=>{
  console.log(`[${now()}] BIST Heatmap Cloud: http://${HOST}:${PORT}`);
  refresh();
  setInterval(refresh,REFRESH_MS);
});
