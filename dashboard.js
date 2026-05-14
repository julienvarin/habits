(function () {
  'use strict';

  // ============================================================
  // In-memory cache
  // ============================================================
  const CACHE = {};
  const TTL = { weather: 30 * 60e3, 'news-global': 15 * 60e3, 'news-germany': 15 * 60e3, cal: 5 * 60e3 };

  function cacheGet(k) {
    const c = CACHE[k];
    return (c && Date.now() - c.ts < (TTL[k] || 15 * 60e3)) ? c.v : null;
  }
  function cacheSet(k, v) { CACHE[k] = { ts: Date.now(), v }; }

  // ============================================================
  // XSS escape
  // ============================================================
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]); }

  // ============================================================
  // Year progress
  // ============================================================
  function yearProgress() {
    const now   = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const end   = new Date(now.getFullYear() + 1, 0, 1);
    const day   = Math.floor((now - start) / 86400000) + 1;
    const total = Math.floor((end - start) / 86400000);
    const pct   = Math.round((day / total) * 1000) / 10;
    return { day, total, pct, year: now.getFullYear() };
  }

  // ============================================================
  // Weather — Open-Meteo, Berlin (no API key)
  // ============================================================
  async function fetchWeather() {
    const cached = cacheGet('weather');
    if (cached) return cached;
    const url =
      'https://api.open-meteo.com/v1/forecast' +
      '?latitude=52.52&longitude=13.41' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode' +
      '&timezone=Europe%2FBerlin&forecast_days=1';
    const r = await fetch(url);
    if (!r.ok) throw new Error('weather');
    const d = await r.json();
    const v = {
      hi:   Math.round(d.daily.temperature_2m_max[0]),
      lo:   Math.round(d.daily.temperature_2m_min[0]),
      rain: d.daily.precipitation_probability_max[0],
      code: d.daily.weathercode[0],
    };
    cacheSet('weather', v);
    return v;
  }

  function wxEmoji(code, rain) {
    if (code === 0)         return '☀️';
    if (code <= 2)          return '⛅';
    if (code <= 3)          return '🌥';
    if (code <= 48)         return '🌫';
    if (code <= 67)         return '🌧';
    if (code <= 77)         return '🌨';
    if (code <= 82)         return '🌦';
    if (code <= 99)         return '⛈';
    return rain > 40 ? '🌧' : '🌤';
  }

  // ============================================================
  // News — rss2json.com (free, no key, 1000 req/day)
  // ============================================================
  async function fetchNews(rssUrl, cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const api = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=5`;
    const r = await fetch(api);
    if (!r.ok) throw new Error('news');
    const d = await r.json();
    if (d.status !== 'ok') throw new Error('news-status');
    const items = (d.items || []).slice(0, 4).map(n => ({
      title: (n.title || '').replace(/\s+/g, ' ').trim(),
      link:  n.link || '#',
    }));
    cacheSet(cacheKey, items);
    return items;
  }

  // ============================================================
  // Calendar — iCal URL via CORS proxy
  // ============================================================
  function parseICalDt(raw) {
    if (!raw) return null;
    const val = raw.includes(':') ? raw.split(':').pop() : raw;
    const s   = val.replace('Z', '');
    if (s.length === 8) {
      return { d: new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)), allDay: true };
    }
    if (s.length >= 15) {
      const isUTC = val.endsWith('Z');
      if (isUTC) {
        const iso = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`;
        return { d: new Date(iso), allDay: false };
      }
      return {
        d: new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8),
                    +s.slice(9,11), +s.slice(11,13), +s.slice(13,15)),
        allDay: false,
      };
    }
    return null;
  }

  function icalLocalDate(raw) {
    const p = parseICalDt(raw);
    if (!p) return null;
    const d = p.d;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function parseICal(text) {
    const out = [];
    const blocks = text.split('BEGIN:VEVENT');
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i].replace(/\r?\n[ \t]/g, ''); // unfold
      const get = name => {
        const m = b.match(new RegExp(`(?:^|\n)${name}[^:\n]*:([^\r\n]*)`, 'i'));
        return m ? m[1].trim() : '';
      };
      const status  = get('STATUS');
      const dtstart = get('DTSTART');
      if (!dtstart || status === 'CANCELLED') continue;
      out.push({ summary: get('SUMMARY') || 'Event', dtstart, dtend: get('DTEND') });
    }
    return out;
  }

  async function fetchCalendar() {
    if (!window.GCAL_ICAL_URL) return null;
    const cached = cacheGet('cal');
    if (cached) return cached;
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(window.GCAL_ICAL_URL)}`;
    const r = await fetch(proxy, { cache: 'no-store' });
    if (!r.ok) throw new Error('calendar');
    const json = await r.json();
    const events = parseICal(json.contents || '');
    cacheSet('cal', events);
    return events;
  }

  function localDateStr(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function eventsForDate(events, ds) {
    return events
      .filter(e => icalLocalDate(e.dtstart) === ds)
      .sort((a, b) => {
        const ta = parseICalDt(a.dtstart)?.d?.getTime() || 0;
        const tb = parseICalDt(b.dtstart)?.d?.getTime() || 0;
        return ta - tb;
      });
  }

  function fmtTime(d) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // ============================================================
  // Render helpers
  // ============================================================
  let shellReady = false;

  function renderShell() {
    const el = document.getElementById('dash-root');
    if (!el) return;
    const { day, total, pct, year } = yearProgress();
    el.innerHTML = `
      <div class="dash-year">
        <div class="dash-year-meta">
          <span class="dash-year-tag">${year}</span>
          <span class="dash-year-info">Day&nbsp;${day}&nbsp;of&nbsp;${total} &middot; ${total - day}&nbsp;days left</span>
          <span class="dash-year-pct">${pct}%</span>
        </div>
        <div class="dash-year-track">
          <div class="dash-year-fill" style="width:${pct}%"></div>
        </div>
      </div>
      <div class="dash-row">
        <div class="dash-widget" id="dw-weather"><div class="dw-spin-wrap"><div class="dw-spin"></div></div></div>
        <div class="dash-widget" id="dw-meetings"><div class="dw-spin-wrap"><div class="dw-spin"></div></div></div>
        <div class="dash-widget dw-news-widget" id="dw-news"><div class="dw-spin-wrap"><div class="dw-spin"></div></div></div>
      </div>`;
    shellReady = true;
  }

  function updateWeather(w) {
    const el = document.getElementById('dw-weather');
    if (!el) return;
    if (!w) {
      el.innerHTML = `<div class="dw-lbl">Berlin</div><div class="dw-err">Unavailable</div>`;
      return;
    }
    const icon  = wxEmoji(w.code, w.rain);
    const rainy = w.rain >= 50;
    el.innerHTML = `
      <div class="dw-lbl">Berlin</div>
      <div class="dw-wx-icon">${icon}</div>
      <div class="dw-temps">
        <span class="dw-hi">↑${w.hi}°</span>
        <span class="dw-sep">/</span>
        <span class="dw-lo">↓${w.lo}°</span>
      </div>
      <div class="dw-rain${rainy ? ' dw-rain-hi' : ''}">
        ${w.rain > 0 ? `🌧 ${w.rain}%` : 'No rain'}
      </div>`;
  }

  function updateMeetings(events) {
    const el = document.getElementById('dw-meetings');
    if (!el) return;
    if (!events) {
      el.innerHTML = `
        <div class="dw-lbl">Meetings</div>
        <div class="dw-cal-hint">Set GCAL_ICAL_URL<br>in config.js to<br>see your events</div>`;
      return;
    }
    const today  = localDateStr(0);
    const tmrw   = localDateStr(1);
    const todayE = eventsForDate(events, today).slice(0, 3);
    const tmrwE  = eventsForDate(events, tmrw).slice(0, 2);

    function evtRow(e) {
      const p      = parseICalDt(e.dtstart);
      const time   = p?.allDay ? 'All day' : (p ? fmtTime(p.d) : '');
      return `<div class="dw-evt">
        <span class="dw-evt-t">${time}</span>
        <span class="dw-evt-n">${esc(e.summary)}</span>
      </div>`;
    }

    el.innerHTML = `
      <div class="dw-lbl">Today</div>
      ${todayE.length ? todayE.map(evtRow).join('') : '<div class="dw-empty">Free</div>'}
      <div class="dw-lbl dw-lbl2">Tomorrow</div>
      ${tmrwE.length ? tmrwE.map(evtRow).join('') : '<div class="dw-empty">Free</div>'}`;
  }

  function updateNews(world, germany) {
    const el = document.getElementById('dw-news');
    if (!el) return;

    function col(items) {
      if (!items.length) return '<div class="dw-empty">—</div>';
      return items.slice(0, 3).map(n =>
        `<a class="dw-news-a" href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
      ).join('');
    }

    el.innerHTML = `
      <div class="dw-news-cols">
        <div class="dw-news-col">
          <div class="dw-lbl">World</div>
          ${col(world)}
        </div>
        <div class="dw-news-col">
          <div class="dw-lbl">Germany</div>
          ${col(germany)}
        </div>
      </div>`;
  }

  // ============================================================
  // Main entry — safe to call multiple times (caching + shell guard)
  // ============================================================
  async function renderDashboard() {
    if (!shellReady) renderShell();

    const [wx, worldNews, gerNews, cal] = await Promise.allSettled([
      fetchWeather(),
      fetchNews('https://feeds.bbci.co.uk/news/world/rss.xml', 'news-global'),
      fetchNews('https://rss.dw.com/rdf/rss-en-ger', 'news-germany'),
      fetchCalendar(),
    ]);

    updateWeather(wx.status === 'fulfilled' ? wx.value : null);
    updateNews(
      worldNews.status === 'fulfilled' ? worldNews.value : [],
      gerNews.status  === 'fulfilled' ? gerNews.value  : []
    );
    updateMeetings(cal.status === 'fulfilled' ? cal.value : null);
  }

  window.renderDashboard = renderDashboard;
})();
