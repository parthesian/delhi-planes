# Plane Spotter

A single-page, dependency-free flight dashboard for spotting aircraft near Dwarka Sector 9, Delhi.

Open `index.html` in a browser to see current aircraft inside the local IGI / Dwarka bounding box. The page:

- Refreshes OpenSky data every 15 seconds with a manual refresh button.
- Uses light `localStorage` caching so quick refreshes do not hammer anonymous OpenSky limits.
- Enriches callsigns/ICAO hex IDs with best-effort airline, aircraft, registration, and route data.
- Shows a mobile-first card layout plus a potential departure queue sorted around low/climbing aircraft.

## Data sources

- OpenSky state vectors: `https://opensky-network.org/api/states/all?lamin=28.45&lomin=77.00&lamax=28.70&lomax=77.25`
- HexDB aircraft lookup: `https://hexdb.io/api/v1/aircraft/{icao24}`
- HexDB route lookup: `https://hexdb.io/api/v1/route/icao/{callsign}`

These free sources can be incomplete or rate-limited. Missing details are shown as `Unknown`.

## Local use

Because this is plain HTML/CSS/JavaScript, either double-click `index.html` or serve the folder:

```bash
python3 -m http.server 8788
```

Then open `http://localhost:8788`.

## Cloudflare deployment

### Cloudflare Pages

Deploy this repository as a static site with:

- Framework preset: `None`
- Build command: leave empty
- Deploy command: leave empty
- Output directory: `/`
- Root directory: `/`

### Cloudflare Workers static assets

If the Cloudflare project is configured to run `npx wrangler deploy`, keep that deploy command. The included `wrangler.toml` points Wrangler at the repository root and deploys `index.html` as Worker static assets.

Equivalent CLI command:

```bash
npx wrangler deploy
```

If direct browser API calls ever need to be replaced, keep the UI and swap the fetch URLs in `index.html` for a Cloudflare Worker or Pages Function that proxies OpenSky/HexDB and returns the same JSON shape.
