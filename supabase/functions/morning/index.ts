// Server-side fetcher for the Morning tab.
//
// Browsers can't read the Google Calendar iCal feed directly (no CORS headers),
// and the free CORS proxies we used keep dying. The public BVG REST wrapper
// (v6.bvg.transport.rest) is also frequently down. This function does both
// fetches server-side and returns them with CORS headers.
//
//   GET /functions/v1/morning?source=ical
//   GET /functions/v1/morning?source=departures&stop=900078102
//   GET /functions/v1/morning?source=rss&url=https://www.lemonde.fr/rss/une.xml
//
// Callers must be signed in as an allowed user (see is_owner() in schema.sql).
//
// Secrets (Supabase dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   ICAL_URL         Google Calendar "Secret address in iCal format" (required for ?source=ical)
//   ALLOWED_ORIGINS  optional, comma-separated, e.g. "https://julienvarin.github.io"

import { createClient } from 'npm:hafas-client@6.3.6';
import { profile as bvgProfile } from 'npm:hafas-client@6.3.6/p/bvg/index.js';
import { profile as vbbProfile } from 'npm:hafas-client@6.3.6/p/vbb/index.js';
import { isOwner } from '../_shared/owner.ts';

const USER_AGENT = 'habits-morning (github.com/julienvarin/habits)';
const hafasClients = [
  createClient(bvgProfile, USER_AGENT),
  createClient(vbbProfile, USER_AGENT),
];

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin  = req.headers.get('Origin') || '';
  const allow   = !allowed.length ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

async function handleIcal(req: Request): Promise<Response> {
  const url = Deno.env.get('ICAL_URL');
  if (!url) return json(req, { error: 'not_configured' }, 404);
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return json(req, { error: `Calendar HTTP ${resp.status}` }, 502);
  const text = await resp.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) return json(req, { error: 'Calendar response is not an iCal feed' }, 502);
  return new Response(text, {
    headers: { ...corsHeaders(req), 'Content-Type': 'text/calendar; charset=utf-8' },
  });
}

// Only these feed hosts can be fetched, so the function isn't an open proxy.
const RSS_HOSTS = new Set(['www.lemonde.fr', 'feeds.thelocal.com', 'www.reddit.com']);

async function handleRss(req: Request, params: URLSearchParams): Promise<Response> {
  let url: URL;
  try { url = new URL(params.get('url') || ''); } catch { return json(req, { error: 'invalid url' }, 400); }
  if (url.protocol !== 'https:' || !RSS_HOSTS.has(url.hostname)) return json(req, { error: 'feed not allowed' }, 400);
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return json(req, { error: `Feed HTTP ${resp.status}` }, 502);
  return new Response(await resp.text(), {
    headers: { ...corsHeaders(req), 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'max-age=300' },
  });
}

const SUBWAY_ONLY = {
  subway: true, suburban: false, tram: false, bus: false,
  ferry: false, express: false, regional: false,
};

async function handleDepartures(req: Request, params: URLSearchParams): Promise<Response> {
  const stop = params.get('stop') || '';
  if (!/^\d{6,12}$/.test(stop)) return json(req, { error: 'invalid stop' }, 400);
  const duration = Math.min(parseInt(params.get('duration') || '90', 10) || 90, 180);
  const results  = Math.min(parseInt(params.get('results')  || '30', 10) || 30, 60);

  // Talk to the BVG and VBB HAFAS backends directly (same data source that
  // transport.rest wraps); then fall back to transport.rest itself.
  const errors: string[] = [];
  for (const client of hafasClients) {
    try {
      const res = await client.departures(stop, { duration, results, products: SUBWAY_ONLY });
      return json(req, { departures: res.departures ?? res });
    } catch (e) {
      errors.push(`hafas: ${(e as Error).message}`);
    }
  }
  try {
    const qs = new URLSearchParams({ duration: String(duration), results: String(results) });
    for (const [k, v] of Object.entries(SUBWAY_ONLY)) qs.set(k, String(v));
    const resp = await fetch(`https://v6.bvg.transport.rest/stops/${stop}/departures?${qs}`,
      { signal: AbortSignal.timeout(12000) });
    if (resp.ok) return json(req, await resp.json());
    errors.push(`transport.rest: HTTP ${resp.status}`);
  } catch (e) {
    errors.push(`transport.rest: ${(e as Error).message}`);
  }
  return json(req, { error: 'Departures unavailable', details: errors }, 502);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  const params = new URL(req.url).searchParams;
  try {
    if (!(await isOwner(req))) return json(req, { error: 'Not signed in' }, 401);
    switch (params.get('source')) {
      case 'ical':       return await handleIcal(req);
      case 'departures': return await handleDepartures(req, params);
      case 'rss':        return await handleRss(req, params);
      default:           return json(req, { error: 'unknown source' }, 400);
    }
  } catch (e) {
    return json(req, { error: (e as Error).message }, 500);
  }
});
