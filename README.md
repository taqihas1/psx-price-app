# PSX Price Tracker — Cloudflare Worker

Live PSX (Pakistan Stock Exchange) prices with a dashboard, JSON API, and daily history — all in one Worker.

## Features

- **Live dashboard** (`/`) — dark UI, auto-refresh every 60s, sparklines from stored history
- **JSON API** (`/api/prices`) — all symbols in one request
- **History API** (`/api/history?symbol=PPL`) — last 90 days from KV
- **Daily snapshot cron** — 5 PM PKT, stored in Workers KV
- **Dual data source** — TradingView scanner API (primary) + PSX DPS (fallback)

## Setup

```bash
npm install

# Create the KV namespace (once), copy the returned id into wrangler.toml
npx wrangler kv namespace create PSX_HISTORY

# Deploy
npm run deploy
```

After deploy you'll get a URL like `https://psx-price-app.<your-subdomain>.workers.dev`.

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Dashboard (HTML) |
| `GET /api/prices` | Live prices for all symbols |
| `GET /api/history?symbol=PPL` | Daily history from KV |
| `GET /api/snapshot` | Manually save today's snapshot (test the cron) |

## Customizing Symbols

Symbols live in the `SYMBOLS` var — edit `wrangler.toml` and push:

```toml
[vars]
SYMBOLS = "SAZEW,MARI,PPL,OGDC,ENGRO,HBL"
```

Or update without touching the repo (immediate, no redeploy):

```bash
npx wrangler vars put SYMBOLS --value "SAZEW,MARI,PPL,OGDC,ENGRO"
```

Or in the Cloudflare dashboard → Workers → psx-price-app → Settings → Variables.

**Ad-hoc queries** (no config change needed):

```
GET /api/prices?symbols=ENGRO,HBL
```

The dashboard also has a symbol input box for one-off lookups.
Current configured list: `GET /api/symbols`.

The daily cron snapshot uses the configured `SYMBOLS` list (not ad-hoc queries).

## Free Tier Limits (plenty for this use case)

- Cron triggers: 3 per Worker/day on free plan — we use 1
- KV writes: 1,000/day — a snapshot is ~5 writes
- Requests: 100,000/day

## Notes

- The TradingView scanner API is unofficial but stable; the PSX DPS endpoint is the automatic fallback per symbol.
- Cron runs at 12:00 UTC (5 PM PKT). PSX closes at 3:30 PM PKT, so end-of-day data is final.
- First day: sparklines will show "no history yet" — they populate after the first snapshot.
