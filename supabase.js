// Tiny REST wrapper around Supabase. No SDK; keeps this dependency-free.
(function () {
  const URL = window.SUPABASE_URL;
  const KEY = window.SUPABASE_ANON_KEY;

  function headers(extra) {
    return Object.assign({
      apikey: KEY,
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json",
    }, extra || {});
  }

  async function req(path, opts) {
    const res = await fetch(URL + "/rest/v1" + path, opts);
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
  };
})();
