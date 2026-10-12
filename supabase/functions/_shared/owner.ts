// Ask PostgREST, as the caller, whether they're on allowed_users (see
// is_owner() in schema.sql). SUPABASE_URL and SUPABASE_ANON_KEY are provided
// to every Edge Function automatically.
export async function isOwner(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/is_owner`, {
    method: 'POST',
    headers: {
      apikey: Deno.env.get('SUPABASE_ANON_KEY') || '',
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  });
  return resp.ok && (await resp.json()) === true;
}
