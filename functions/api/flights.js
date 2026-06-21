const AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/point/28.5796008/77.0702411/35";
const ADSB_LOL_URL = "https://api.adsb.lol/v2/point/28.5796008/77.0702411/35";
const MAX_ENRICHED_FLIGHTS = 20;
const FLIGHT_CACHE_TTL_SECONDS = 60;
const ENRICHMENT_CACHE_TTL_SECONDS = 60 * 60;
const BOUNDS = {
  minLat: 28.45,
  maxLat: 28.70,
  minLon: 77.00,
  maxLon: 77.25
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export async function onRequestGet() {
  try {
    const states = await fetchAircraftStates(AIRPLANES_LIVE_URL, "Airplanes.live");
    const enrichment = await enrichStates(states.slice(0, MAX_ENRICHED_FLIGHTS));

    return json({
      receivedAt: Date.now(),
      source: "airplanes-live",
      states,
      enrichment
    });
  } catch (primaryError) {
    try {
      const states = await fetchAircraftStates(ADSB_LOL_URL, "adsb.lol");
      const enrichment = await enrichStates(states.slice(0, MAX_ENRICHED_FLIGHTS));

      return json({
        receivedAt: Date.now(),
        source: "adsb-lol-backup",
        warning: `Airplanes.live unavailable, using backup aircraft feed. ${primaryError.message || ""}`.trim(),
        states,
        enrichment
      });
    } catch (backupError) {
      return json(
        { error: `Radar feeds failed: ${backupError.message || primaryError.message || "unknown error"}` },
        502
      );
    }
  }
}

async function fetchAircraftStates(url, providerName) {
  const response = await fetch(url, {
      cf: {
        cacheEverything: true,
        cacheTtl: FLIGHT_CACHE_TTL_SECONDS
      },
      headers: {
        "accept": "application/json",
        "user-agent": "plane-spotter-dashboard/1.0"
      }
  });

  if (!response.ok) {
    throw new Error(`${providerName} returned ${response.status}`);
  }

  const payload = await response.json();
  const aircraft = Array.isArray(payload.ac) ? payload.ac : [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  return aircraft
    .filter((aircraft) => aircraft.lat !== undefined && aircraft.lon !== undefined)
    .filter((aircraft) => aircraft.lat >= BOUNDS.minLat && aircraft.lat <= BOUNDS.maxLat)
    .filter((aircraft) => aircraft.lon >= BOUNDS.minLon && aircraft.lon <= BOUNDS.maxLon)
    .map((aircraft) => toStateVector(aircraft, nowSeconds));
}

function toStateVector(aircraft, nowSeconds) {
  const altitudeFeet = numericAltitude(aircraft.alt_geom ?? aircraft.alt_baro);
  const baroAltitudeFeet = numericAltitude(aircraft.alt_baro ?? aircraft.alt_geom);
  const lastSeenSeconds = Number.isFinite(aircraft.seen) ? Math.max(0, Math.round(aircraft.seen)) : 0;

  return [
    aircraft.hex || "",
    aircraft.flight || "",
    aircraft.country || "Unknown",
    nowSeconds - lastSeenSeconds,
    nowSeconds - lastSeenSeconds,
    aircraft.lon,
    aircraft.lat,
    feetToMeters(baroAltitudeFeet),
    aircraft.alt_baro === "ground",
    knotsToMetersPerSecond(aircraft.gs),
    aircraft.track ?? aircraft.true_heading ?? aircraft.mag_heading ?? null,
    feetPerMinuteToMetersPerSecond(aircraft.geom_rate ?? aircraft.baro_rate),
    null,
    feetToMeters(altitudeFeet),
    aircraft.squawk || null,
    false,
    0
  ];
}

async function enrichStates(states) {
  const entries = await Promise.all(states.map(async (state) => {
    const icao24 = state?.[0];
    const callsign = String(state?.[1] || "").trim();
    if (!icao24) return null;

    const [aircraft, route] = await Promise.all([
      fetchAircraft(icao24),
      fetchRoute(callsign)
    ]);

    return [icao24, {
      aircraftType: aircraft.type || aircraft.model || "Unknown",
      registration: aircraft.registration || "Unknown",
      origin: route.origin || "Unknown",
      destination: route.destination || "Unknown"
    }];
  }));

  return Object.fromEntries(entries.filter(Boolean));
}

async function fetchAircraft(icao24) {
  if (!icao24) return {};

  const data = await fetchJson(`https://hexdb.io/api/v1/aircraft/${icao24}`);
  return {
    registration: pick(data, ["registration", "Registration", "reg", "Reg"]),
    type: pick(data, ["type", "Type", "icaoTypeCode", "ICAOTypeCode", "aircraft", "Aircraft"]),
    model: pick(data, ["model", "Model", "manufacturer", "Manufacturer"])
  };
}

async function fetchRoute(callsign) {
  if (!callsign) return {};

  const data = await fetchJson(`https://hexdb.io/api/v1/route/icao/${encodeURIComponent(callsign)}`);
  const routeText = typeof data === "string" ? data : pick(data, ["route", "Route"]);
  const pieces = Array.isArray(data) ? data.map(cleanAirportCode).filter(Boolean) : splitRoute(routeText);
  const origin = pick(data, ["origin", "Origin", "departure", "Departure", "from", "From"]) || pieces?.[0];
  const destination = pick(data, ["destination", "Destination", "arrival", "Arrival", "to", "To"]) || pieces?.[pieces.length - 1];

  return {
    origin: cleanAirportCode(origin),
    destination: cleanAirportCode(destination)
  };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      cf: {
        cacheEverything: true,
        cacheTtl: ENRICHMENT_CACHE_TTL_SECONDS
      },
      headers: {
        "accept": "application/json",
        "user-agent": "plane-spotter-dashboard/1.0"
      }
    });
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

function pick(source, keys) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return "";
  for (const key of keys) {
    if (source[key]) return source[key];
  }
  return "";
}

function cleanAirportCode(value) {
  if (!value) return "";
  return String(value).trim().replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function splitRoute(routeText) {
  if (!routeText) return [];
  return String(routeText)
    .split(/[-–>\/\s]+/)
    .map(cleanAirportCode)
    .filter(Boolean);
}

function numericAltitude(value) {
  if (value === "ground" || value === undefined || value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function feetToMeters(value) {
  return value === null ? null : value / 3.28084;
}

function knotsToMetersPerSecond(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1.94384 : null;
}

function feetPerMinuteToMetersPerSecond(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 0.00508 : null;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders
  });
}
