// Tiny REST wrapper around Supabase. No SDK; keeps this dependency-free.
(function () {
  const URL = window.SUPABASE_URL;
  const KEY = window.SUPABASE_ANON_KEY;

  // ------------------------------------------------------------
  // Auth: email one-time code (Supabase Auth REST). A code typed into the app
  // works inside the iOS home-screen app, where a magic link would open Safari
  // (separate storage) instead.
  // ------------------------------------------------------------
  const SESSION_KEY = "habits.session";
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { session = null; }
  let refreshing = null;

  function saveSession(data) {
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      email: data.user?.email || session?.email || null,
    };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
  }

  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  async function authReq(path, body) {
    const res = await fetch(URL + "/auth/v1" + path, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.msg || data.error_description || data.message || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Refresh the access token. Concurrent callers share one request, since
  // Supabase rotates refresh tokens and a second use of the old one fails.
  function refresh() {
    if (!session?.refresh_token) return Promise.reject(new Error("Not signed in"));
    if (!refreshing) {
      refreshing = authReq("/token?grant_type=refresh_token", { refresh_token: session.refresh_token })
        .then(saveSession)
        .catch(err => {
          // 400/401 = refresh token revoked or expired; network errors keep the session.
          if (err.status === 400 || err.status === 401) { clearSession(); window.dispatchEvent(new Event("habits:signedout")); }
          throw err;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function accessToken() {
    if (!session) return null;
    if (session.expires_at - 60 < Date.now() / 1000) {
      try { await refresh(); } catch { /* offline: try the old token */ }
    }
    return session?.access_token || null;
  }

  window.auth = {
    isSignedIn: () => !!session,
    email: () => session?.email || null,
    sendCode(email) {
      // create_user: false — the account is created once in the Supabase dashboard.
      return authReq("/otp", { email, create_user: false });
    },
    async verifyCode(email, token) {
      saveSession(await authReq("/verify", { type: "email", email, token }));
    },
    async signInWithPassword(email, password) {
      saveSession(await authReq("/token?grant_type=password", { email, password }));
    },
    // Magic-link fallback: Supabase redirects to the site with the session in
    // the URL fragment (#access_token=…&refresh_token=…). Returns true if found.
    consumeRedirect() {
      const h = new URLSearchParams(location.hash.slice(1));
      if (!h.get("access_token") || !h.get("refresh_token")) return false;
      saveSession({
        access_token: h.get("access_token"),
        refresh_token: h.get("refresh_token"),
        expires_at: parseInt(h.get("expires_at"), 10) || undefined,
        expires_in: parseInt(h.get("expires_in"), 10) || 3600,
      });
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    },
    async signOut() {
      const token = session?.access_token;
      clearSession();
      if (token) {
        fetch(URL + "/auth/v1/logout", { method: "POST", headers: { apikey: KEY, Authorization: "Bearer " + token } }).catch(() => {});
      }
    },
    accessToken,
    // Headers for calling Supabase Edge Functions as the signed-in user.
    async headers() {
      const token = await accessToken();
      return token ? { apikey: KEY, Authorization: "Bearer " + token } : { apikey: KEY };
    },
  };

  function headers(extra) {
    return Object.assign({
      apikey: KEY,
      "Content-Type": "application/json",
    }, extra || {});
  }

  async function req(path, opts, retried) {
    const token = await accessToken();
    const o = Object.assign({}, opts, {
      headers: Object.assign({}, opts && opts.headers, { Authorization: "Bearer " + (token || KEY) }),
    });
    const res = await fetch(URL + "/rest/v1" + path, o);
    if (res.status === 401 && session && !retried) {
      await refresh();
      return req(path, opts, true);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(res.status + " " + body);
    }
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  window.db = {
    listHabits() {
      return req("/habits?select=*&archived=eq.false&order=sort_order.asc,created_at.asc", {
        headers: headers(),
      });
    },
    listEntries() {
      return req("/entries?select=habit_id,date&order=date.asc", { headers: headers() });
    },
    addHabit(name, color, sort_order, section) {
      const body = { name, color, sort_order };
      if (section) body.section = section;
      return req("/habits", {
        method: "POST",
        headers: headers({ Prefer: "return=representation" }),
        body: JSON.stringify(body),
      }).then(arr => arr[0]);
    },
    updateHabit(id, patch) {
      return req("/habits?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(patch),
      });
    },
    deleteHabit(id) {
      return req("/habits?id=eq." + encodeURIComponent(id), {
        method: "DELETE",
        headers: headers(),
      });
    },
    tick(habit_id, date) {
      return req("/entries", {
        method: "POST",
        headers: headers({ Prefer: "resolution=ignore-duplicates" }),
        body: JSON.stringify({ habit_id, date }),
      });
    },
    untick(habit_id, date) {
      return req(
        "/entries?habit_id=eq." + encodeURIComponent(habit_id) +
        "&date=eq." + encodeURIComponent(date),
        { method: "DELETE", headers: headers() }
      );
    },
    listTodos() {
      return req("/todos?select=*&order=created_at.desc", { headers: headers() });
    },
    addTodo(todo) {
      return req("/todos", {
        method: "POST",
        headers: headers({ Prefer: "return=minimal,resolution=merge-duplicates" }),
        body: JSON.stringify(todo),
      });
    },
    updateTodo(id, patch) {
      return req("/todos?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify(patch),
      });
    },
    deleteTodo(id) {
      return req("/todos?id=eq." + encodeURIComponent(id), {
        method: "DELETE",
        headers: headers(),
      });
    },
    listJournal() {
      return req("/journal?select=*&order=date.desc", { headers: headers() });
    },
    upsertJournal(entry) {
      // Upsert on the `date` primary key.
      return req("/journal", {
        method: "POST",
        headers: headers({ Prefer: "return=minimal,resolution=merge-duplicates" }),
        body: JSON.stringify(entry),
      });
    },
    savePushSubscription(sub) {
      return req("/push_subscriptions", {
        method: "POST",
        headers: headers({ Prefer: "return=minimal,resolution=merge-duplicates" }),
        body: JSON.stringify(sub),
      });
    },
    deletePushSubscription(endpoint) {
      return req("/push_subscriptions?endpoint=eq." + encodeURIComponent(endpoint), {
        method: "DELETE",
        headers: headers(),
      });
    },
    deleteJournal(date) {
      return req("/journal?date=eq." + encodeURIComponent(date), {
        method: "DELETE",
        headers: headers(),
      });
    },
  };
})();
