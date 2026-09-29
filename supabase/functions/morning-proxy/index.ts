// Server-side fetcher for Morning-tab sources that don't send CORS headers.
//   GET ?src=ical        → the Google Calendar iCal feed (URL from the ICAL_URL secret)
//   GET ?url=<feed url>  → an allowlisted RSS/Atom feed
// Deploy: supabase functions deploy morning-proxy --no-verify-jwt
//         supabase secrets set ICAL_URL="https://calendar.google.com/calendar/ical/…/basic.ics"

const ALLOWED_HOSTS = new Set([
  "www.lemonde.fr",
  "feeds.thelocal.com",
  "www.reddit.com",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function reply(body: string, status: number, extra: Record<string, string> = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return reply("", 204);
  if (req.method !== "GET") return reply("Method not allowed", 405);

  const params = new URL(req.url).searchParams;
  let target: string | null = null;
  if (params.get("src") === "ical") {
    target = Deno.env.get("ICAL_URL") ?? null;
    if (!target) return reply("ICAL_URL secret not set", 500);
  } else if (params.get("url")) {
    let u: URL;
    try { u = new URL(params.get("url")!); } catch { return reply("Bad url", 400); }
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
      return reply("Host not allowed", 403);
    }
    target = u.toString();
  } else {
    return reply("Missing src or url", 400);
  }

  try {
    const upstream = await fetch(target, {
      // Reddit rejects requests without a descriptive User-Agent.
      headers: { "User-Agent": "habits-morning-proxy/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    const body = await upstream.text();
    return reply(body, upstream.ok ? 200 : 502, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    });
  } catch (e) {
    return reply(`Upstream fetch failed: ${(e as Error).message}`, 502);
  }
});
