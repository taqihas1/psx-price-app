// ============================================================================
// PSX Price Tracker — Cloudflare Worker
//
// Endpoints:
//   GET /              -> live dashboard (HTML, auto-refresh)
//   GET /api/prices    -> live prices JSON (TradingView primary, PSX fallback)
//   GET /api/history?symbol=PPL -> stored daily history from KV
//   GET /api/snapshot  -> manual daily save (for testing the cron path)
//
// Cron: daily at 12:00 UTC = 5:00 PM PKT (PSX closes 3:30 PM PKT)
// ============================================================================

const SYMBOLS = ["SAZEW", "MARI", "PPL", "OGDC"];
const TV_SCAN_URL = "https://scanner.tradingview.com/pakistan/scan";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Content-Type": "application/json",
};

// Column indexes in the TradingView scanner response
const COL = { NAME: 0, CLOSE: 1, HIGH: 2, LOW: 3, VOLUME: 4, CHANGE: 5 };

// ----------------------------------------------------------------------------
// Price fetching
// ----------------------------------------------------------------------------
async function fetchFromTradingView() {
  const payload = {
    symbols: { tickers: SYMBOLS.map((s) => `PSX:${s}`), query: { types: [] } },
    columns: ["name", "close", "high", "low", "volume", "change"],
  };

  const res = await fetch(TV_SCAN_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`TradingView HTTP ${res.status}`);

  const json = await res.json();
  if (!json.data || !json.data.length) throw new Error("TradingView: empty data");

  const bySymbol = {};
  for (const row of json.data) {
    const sym = row.s.split(":")[1]; // "PSX:PPL" -> "PPL"
    bySymbol[sym] = {
      name: row.d[COL.NAME],
      close: row.d[COL.CLOSE],
      high: row.d[COL.HIGH],
      low: row.d[COL.LOW],
      volume: row.d[COL.VOLUME],
      change_pct: row.d[COL.CHANGE],
      source: "tradingview",
      timestamp: new Date().toISOString(),
    };
  }
  return bySymbol;
}

async function fetchFromPSX(symbol) {
  const res = await fetch(`https://dps.psx.com.pk/timeseries/int/${symbol}`, {
    headers: HEADERS,
  });
  if (!res.ok) throw new Error(`PSX HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== 1 || !json.data || !json.data.length)
    throw new Error("PSX: no tick data");

  const prices = json.data.map((t) => t[1]);
  return {
    name: symbol,
    close: prices[prices.length - 1],
    high: Math.max(...prices),
    low: Math.min(...prices),
    volume: json.data.reduce((a, t) => a + (t[2] || 0), 0),
    change_pct: null,
    source: "psx",
    timestamp: new Date().toISOString(),
  };
}

async function getAllPrices() {
  let tvData = null;
  try {
    tvData = await fetchFromTradingView();
  } catch (e) {
    console.error("TradingView failed:", e.message);
  }

  const results = {};
  await Promise.all(
    SYMBOLS.map(async (sym) => {
      if (tvData && tvData[sym]) {
        results[sym] = tvData[sym];
        return;
      }
      try {
        results[sym] = await fetchFromPSX(sym);
      } catch (e) {
        console.error(`PSX fallback failed for ${sym}:`, e.message);
        results[sym] = { name: sym, error: "N/A", timestamp: new Date().toISOString() };
      }
    })
  );
  return results;
}

// ----------------------------------------------------------------------------
// KV history
// ----------------------------------------------------------------------------
async function saveDailySnapshot(env, prices) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  let index = [];
  try {
    index = JSON.parse((await env.PSX_HISTORY.get("index")) || "[]");
  } catch (_) {}
  if (!index.includes(date)) index.push(date);

  const ops = SYMBOLS.map((sym) => {
    const p = prices[sym];
    if (!p || p.error) return null;
    return env.PSX_HISTORY.put(`${date}:${sym}`, JSON.stringify(p));
  }).filter(Boolean);

  ops.push(env.PSX_HISTORY.put("index", JSON.stringify(index)));
  await Promise.all(ops);
  return { date, saved: ops.length - 1 };
}

async function getHistory(env, symbol) {
  let index = [];
  try {
    index = JSON.parse((await env.PSX_HISTORY.get("index")) || "[]");
  } catch (_) {}
  index.sort();

  const rows = [];
  for (const date of index.slice(-90)) {
    const v = await env.PSX_HISTORY.get(`${date}:${symbol}`);
    if (v) rows.push({ date, ...JSON.parse(v) });
  }
  return rows;
}

// ----------------------------------------------------------------------------
// Responses
// ----------------------------------------------------------------------------
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });

// ----------------------------------------------------------------------------
// Dashboard HTML
// ----------------------------------------------------------------------------
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PSX Price Tracker</title>
<style>
  :root { --bg:#0b1220; --card:#131c2e; --border:#1f2b44; --txt:#e6edf7;
          --dim:#8b9bb8; --up:#22c55e; --down:#ef4444; --accent:#38bdf8; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt);
         font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
         min-height:100vh; padding:24px; }
  .wrap { max-width:1100px; margin:0 auto; }
  header { display:flex; justify-content:space-between; align-items:center;
           margin-bottom:20px; flex-wrap:wrap; gap:12px; }
  h1 { font-size:22px; letter-spacing:.5px; }
  h1 span { color:var(--accent); }
  .meta { color:var(--dim); font-size:12px; }
  button { background:var(--accent); color:#04121f; border:0; padding:8px 16px;
           border-radius:8px; font-weight:600; cursor:pointer; font-size:13px; }
  button:hover { filter:brightness(1.1); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
          gap:16px; }
  .card { background:var(--card); border:1px solid var(--border);
          border-radius:14px; padding:18px; }
  .sym { font-size:13px; font-weight:700; letter-spacing:1px; color:var(--dim); }
  .name { font-size:12px; color:var(--dim); margin-top:2px; min-height:15px; }
  .close { font-size:30px; font-weight:700; margin:10px 0 2px; }
  .chg { font-size:13px; font-weight:600; margin-bottom:12px; }
  .up { color:var(--up); } .down { color:var(--down); }
  .row { display:flex; justify-content:space-between; font-size:12px;
         color:var(--dim); padding:3px 0; }
  .row b { color:var(--txt); font-weight:600; }
  .src { font-size:10px; color:var(--dim); margin-top:10px; text-transform:uppercase;
         letter-spacing:1px; }
  canvas { width:100%; height:40px; margin-top:10px; }
  #status { margin-top:16px; text-align:center; color:var(--dim); font-size:12px; }
  a { color:var(--accent); text-decoration:none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>PSX <span>Price Tracker</span></h1>
      <div class="meta" id="updated">Loading…</div>
    </div>
    <div>
      <button onclick="saveSnapshot()">Save Daily Snapshot</button>
    </div>
  </header>
  <div class="grid" id="cards"></div>
  <div id="status">Auto-refresh every 60s · Data: TradingView / PSX</div>
</div>
<script>
var SYMBOLS = ${JSON.stringify(SYMBOLS)};

function fmt(n) {
  if (n == null) return "N/A";
  return Number(n).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
}
function fmtVol(n) {
  if (n == null) return "N/A";
  return n >= 1e6 ? (n/1e6).toFixed(2) + "M" : n >= 1e3 ? (n/1e3).toFixed(1) + "K" : String(n);
}

function sparkline(canvas, rows) {
  var ctx = canvas.getContext("2d");
  var w = canvas.width = canvas.offsetWidth * 2;
  var h = canvas.height = 80;
  ctx.clearRect(0, 0, w, h);
  if (!rows || rows.length < 2) {
    ctx.fillStyle = "#8b9bb8"; ctx.font = "18px sans-serif";
    ctx.fillText("no history yet", 8, h/2);
    return;
  }
  var closes = rows.map(function(r){ return r.close; });
  var min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
  var rng = (max - min) || 1;
  ctx.beginPath();
  closes.forEach(function(c, i) {
    var x = (i / (closes.length - 1)) * (w - 8) + 4;
    var y = h - 10 - ((c - min) / rng) * (h - 20);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#38bdf8"; ctx.lineWidth = 3; ctx.stroke();
}

function render(prices) {
  var grid = document.getElementById("cards");
  grid.innerHTML = "";
  SYMBOLS.forEach(function(sym, idx) {
    var p = prices[sym] || {};
    var chg = p.change_pct;
    var cls = chg == null ? "" : (chg >= 0 ? "up" : "down");
    var arrow = chg == null ? "" : (chg >= 0 ? "▲ " : "▼ ");
    var card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="sym">' + sym + '</div>' +
      '<div class="name">' + (p.name || "") + '</div>' +
      '<div class="close">' + fmt(p.close) + '</div>' +
      '<div class="chg ' + cls + '">' + arrow + (chg == null ? "" : chg.toFixed(2) + "%") + '</div>' +
      '<div class="row"><span>High</span><b>' + fmt(p.high) + '</b></div>' +
      '<div class="row"><span>Low</span><b>' + fmt(p.low) + '</b></div>' +
      '<div class="row"><span>Volume</span><b>' + fmtVol(p.volume) + '</b></div>' +
      '<div class="src">via ' + (p.source || "-") + '</div>' +
      '<canvas></canvas>';
    grid.appendChild(card);

    fetch("/api/history?symbol=" + sym)
      .then(function(r){ return r.json(); })
      .then(function(rows){ sparkline(card.querySelector("canvas"), rows); })
      .catch(function(){});
  });
  document.getElementById("updated").textContent =
    "Last updated: " + new Date().toLocaleString();
}

function load() {
  fetch("/api/prices")
    .then(function(r){ return r.json(); })
    .then(render)
    .catch(function(e){
      document.getElementById("updated").textContent = "Error loading prices";
    });
}

function saveSnapshot() {
  document.getElementById("status").textContent = "Saving snapshot…";
  fetch("/api/snapshot")
    .then(function(r){ return r.json(); })
    .then(function(j){
      document.getElementById("status").textContent =
        "Snapshot saved for " + j.date + " (" + j.saved + " symbols)";
    })
    .catch(function(){
      document.getElementById("status").textContent = "Snapshot failed";
    });
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`;
}

// ----------------------------------------------------------------------------
// Worker entry
// ----------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/api/prices":
        return jsonResponse(await getAllPrices());

      case "/api/history": {
        const sym = (url.searchParams.get("symbol") || "PPL").toUpperCase();
        return jsonResponse(await getHistory(env, sym));
      }

      case "/api/snapshot": {
        const prices = await getAllPrices();
        const saved = await saveDailySnapshot(env, prices);
        return jsonResponse({ ok: true, ...saved });
      }

      default:
        return new Response(dashboardHtml(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }
  },

  // Cron: 12:00 UTC = 5:00 PM PKT (post-market close)
  async scheduled(event, env) {
    const prices = await getAllPrices();
    await saveDailySnapshot(env, prices);
    console.log("Daily snapshot saved at", new Date().toISOString());
  },
};
