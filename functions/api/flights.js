const OPENSKY_URL = "https://opensky-network.org/api/states/all?lamin=28.45&lomin=77.00&lamax=28.70&lomax=77.25";
const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/point/28.5796008/77.0702411/35";
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

let openSkyTokenCache = null;

export async function onRequestGet({ env } = {}) {
  try {
    const openSky = await fetchOpenSky(env);
    const states = Array.isArray(openSky.states) ? openSky.states : [];
    const enrichment = await enrichStates(states.slice(0, MAX_ENRICHED_FLIGHTS));

    return json({
      receivedAt: Date.now(),
      source: "opensky",
      states,
      enrichment
    });
  } catch (openSkyError) {
    try {
      const states = await fetchFallbackStates();
      const enrichment = await enrichStates(states.slice(0, MAX_ENRICHED_FLIGHTS));

      return json({
        receivedAt: Date.now(),
        source: "airplanes-live-fallback",
        warning: `OpenSky unavailable, using fallback aircraft feed. ${openSkyError.message || ""}`.trim(),
        states,
        enrichment
      });
    } catch (fallbackError) {
      return json(
        { error: `Radar feeds failed: ${fallbackError.message || openSkyError.message || "unknown error"}` },
        502
      );
    }
  }
}

async function fetchOpenSky(env) {
  const token = await getOpenSkyToken(env);
  const openSkyResponse = await requestOpenSky(token);

  if (openSkyResponse.status === 401 && token) {
    const refreshedToken = await getOpenSkyToken(env, { forceRefresh: true });
    const retriedResponse = await requestOpenSky(refreshedToken);
    return parseOpenSkyResponse(retriedResponse);
  }

  return parseOpenSkyResponse(openSkyResponse);
}

async function requestOpenSky(token) {
  const headers = {
    "accept": "application/json",
    "user-agent": "plane-spotter-dashboard/1.0"
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(OPENSKY_URL, {
    cf: {
      cacheEverything: true,
      cacheTtl: FLIGHT_CACHE_TTL_SECONDS
    },
    headers
  });
}

async function parseOpenSkyResponse(openSkyResponse) {
  if (!openSkyResponse.ok) {
    throw new Error(`OpenSky returned ${openSkyResponse.status}`);
  }

  return openSkyResponse.json();
}

async function getOpenSkyToken(env, { forceRefresh = false } = {}) {
  const clientId = env?.OPENSKY_CLIENT_ID;
  const clientSecret = env?.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return "";

  const now = Date.now();
  if (!forceRefresh && openSkyTokenCache && openSkyTokenCache.expiresAt > now + 30_000) {
    return openSkyTokenCache.accessToken;
  }

  try {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);

    const openSkyResponse = await fetch(OPENSKY_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "application/json"
      },
      body
    });

    if (!openSkyResponse.ok) {
      console.warn(`OpenSky token request returned ${openSkyResponse.status}; using anonymous access.`);
      return "";
    }

    const payload = await openSkyResponse.json();
    if (!payload.access_token) {
      console.warn("OpenSky token response did not include an access token; using anonymous access.");
      return "";
    }

    const expiresInMs = Number(payload.expires_in || 1800) * 1000;
    openSkyTokenCache = {
      accessToken: payload.access_token,
      expiresAt: now + expiresInMs
    };

    return openSkyTokenCache.accessToken;
  } catch (error) {
    console.warn(`OpenSky token request failed: ${error.message || "unknown error"}; using anonymous access.`);
    return "";
  }
}

async function fetchFallbackStates() {
  const response = await fetch(AIRPLANES_LIVE_URL, {
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
    throw new Error(`Fallback feed returned ${response.status}`);
  }

  const payload = await response.json();
  const aircraft = Array.isArray(payload.ac) ? payload.ac : [];
  const nowSeconds = Math.floor(Date.now() / 1000);

  return aircraft
    .filter((aircraft) => aircraft.lat !== undefined && aircraft.lon !== undefined)
    .filter((aircraft) => aircraft.lat >= BOUNDS.minLat && aircraft.lat <= BOUNDS.maxLat)
    .filter((aircraft) => aircraft.lon >= BOUNDS.minLon && aircraft.lon <= BOUNDS.maxLon)
    .map((aircraft) => toOpenSkyState(aircraft, nowSeconds));
}

function toOpenSkyState(aircraft, nowSeconds) {
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
