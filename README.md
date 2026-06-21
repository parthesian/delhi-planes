# Plane Spotter

A single-page, dependency-free flight dashboard for spotting aircraft near Dwarka Sector 9, Delhi.

Open `index.html` in a browser to see current aircraft inside the local IGI / Dwarka bounding box. The page:

- Refreshes flight data every 5 minutes for one hour, then waits for another manual refresh.
- Includes a manual refresh button for an immediate new snapshot.
- Uses light `localStorage` caching so scheduled refreshes stay gentle.
- Enriches callsigns/ICAO hex IDs with best-effort airline, aircraft, registration, and route data.
- Shows a mobile-first card layout plus a potential departure queue sorted around low/climbing aircraft.
- Uses a Cloudflare Pages Function at `/api/flights` for the flight feed and enrichment.

## Data sources

- OpenSky state vectors: `https://opensky-network.org/api/states/all?lamin=28.45&lomin=77.00&lamax=28.70&lomax=77.25`
- HexDB aircraft lookup: `https://hexdb.io/api/v1/aircraft/{icao24}`
- HexDB route lookup: `https://hexdb.io/api/v1/route/icao/{callsign}`
- Backup aircraft feed if OpenSky is unavailable: `https://api.airplanes.live/v2/point/28.5796008/77.0702411/35`

These free sources can be incomplete or rate-limited. Missing details are shown as `Unknown`.

## Local use

Because this is plain HTML/CSS/JavaScript, either double-click `index.html` or serve the folder:

```bash
python3 -m http.server 8788
```

Then open `http://localhost:8788`.

For the closest match to Cloudflare Pages Functions locally, use:

```bash
npx wrangler pages dev .
```

## Cloudflare deployment

For Cloudflare Pages, deploy this repository as a static site with:

- Build command: none
- Deploy command: none
- Output directory: `/`

Cloudflare will automatically detect the `functions/` directory and expose `/api/flights` on the same Pages domain.

Set these Cloudflare Pages environment variables for authenticated OpenSky requests:

- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`

For local Pages Function testing with Wrangler, put the same keys in `.dev.vars` and keep that file out of git.
