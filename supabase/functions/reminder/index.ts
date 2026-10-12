// Daily habit reminder via Web Push.
//
//   POST /functions/v1/reminder                    called by pg_cron (see README);
//                                                  sends once per day, at REMINDER_HOUR
//                                                  local time, if habits are unticked
//   GET  /functions/v1/reminder?action=public-key  VAPID public key for subscribing
//   POST /functions/v1/reminder?action=test        signed-in owner only: send a test now
//
// The cron call needs no secret: it can only ever send one reminder per day,
// and only during the reminder hour. VAPID keys are generated on first use and
// stored in push_config (no API access; read here with the service role key).
//
// Optional secrets: REMINDER_HOUR (default 23), REMINDER_TZ (default Europe/Berlin),
// VAPID_SUBJECT (default the site URL), ALLOWED_ORIGINS (as for `morning`).

import webpush from 'npm:web-push@3.6.7';
import { isOwner } from '../_shared/owner.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const HOUR    = parseInt(Deno.env.get('REMINDER_HOUR') || '23', 10);
const TZ      = Deno.env.get('REMINDER_TZ') || 'Europe/Berlin';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'https://julienvarin.github.io/habits/';

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin  = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': !allowed.length ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

// PostgREST as the service role (bypasses RLS).
async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!resp.ok) throw new Error(`${path.split('?')[0]}: HTTP ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const rows = await rest('/push_config?select=vapid_public,vapid_private&id=eq.1');
  if (rows.length) return { publicKey: rows[0].vapid_public, privateKey: rows[0].vapid_private };
  const keys = webpush.generateVAPIDKeys();
  // ignore-duplicates + re-read: if two requests race, both end up with the stored pair.
  await rest('/push_config', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ id: 1, vapid_public: keys.publicKey, vapid_private: keys.privateKey }),
  });
  const again = await rest('/push_config?select=vapid_public,vapid_private&id=eq.1');
  return { publicKey: again[0].vapid_public, privateKey: again[0].vapid_private };
}

// Local date (YYYY-MM-DD) and hour in the reminder time zone.
function localNow(): { day: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) };
}

async function sendToAll(payload: Record<string, string>): Promise<{ sent: number; removed: number; failed: string[] }> {
  const keys = await vapidKeys();
  const subs = await rest('/push_subscriptions?select=endpoint,p256dh,auth');
  let sent = 0, removed = 0;
  const failed: string[] = [];
  for (const s of subs) {
    // generateRequestDetails does the encryption; the request itself goes
    // through fetch rather than node:https.
    const details = webpush.generateRequestDetails(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: SUBJECT, ...keys }, TTL: 3600, urgency: 'normal' },
    );
    const resp = await fetch(details.endpoint, {
      method: details.method,
      headers: details.headers as Record<string, string>,
      body: details.body,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) sent++;
    else if (resp.status === 404 || resp.status === 410) {
      // Subscription expired or the device unsubscribed.
      await rest(`/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' });
      removed++;
    } else failed.push(`HTTP ${resp.status} ${await resp.text()}`.slice(0, 200));
  }
  return { sent, removed, failed };
}

async function uncheckedHabits(day: string): Promise<string[]> {
  const habits  = await rest('/habits?select=id,name&archived=eq.false&order=sort_order.asc,created_at.asc');
  const entries = await rest(`/entries?select=habit_id&date=eq.${day}`);
  const done = new Set(entries.map((e: { habit_id: string }) => e.habit_id));
  return habits.filter((h: { id: string }) => !done.has(h.id)).map((h: { name: string }) => h.name);
}

function reminderText(left: string[]): string {
  if (left.length === 1) return `Still to do today: ${left[0]}`;
  const shown = left.slice(0, 4).join(', ');
  return `${left.length} habits left today: ${shown}${left.length > 4 ? '…' : ''}`;
}

async function cronRun(req: Request): Promise<Response> {
  const { day, hour } = localNow();
  if (hour !== HOUR) return json(req, { skipped: `not ${HOUR}:00 in ${TZ}` });
  const left = await uncheckedHabits(day);
  if (!left.length) return json(req, { skipped: 'all habits done' });
  // Claim today's slot first so overlapping cron runs can't both send.
  const claimed = await rest('/reminder_log', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ day }),
  });
  if (!claimed.length) return json(req, { skipped: 'already sent today' });
  const result = await sendToAll({ title: 'Habits', body: reminderText(left), tag: `reminder-${day}` });
  return json(req, result);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });
  const action = new URL(req.url).searchParams.get('action');
  try {
    if (action === 'public-key') return json(req, { publicKey: (await vapidKeys()).publicKey });
    if (action === 'test') {
      if (!(await isOwner(req))) return json(req, { error: 'Not signed in' }, 401);
      const left = await uncheckedHabits(localNow().day);
      const body = left.length ? reminderText(left) : 'All habits done today. Nice!';
      return json(req, await sendToAll({ title: 'Habits (test)', body, tag: 'reminder-test' }));
    }
    return await cronRun(req);
  } catch (e) {
    return json(req, { error: (e as Error).message }, 500);
  }
});
