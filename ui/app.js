import {
  loadShows, compareWithTmdb, episodeLabel, episodeRanges, episodeKey, minutesLeft, timeAgo,
  dayLabel, dayString, airDay, airTime, hasAired,
} from "./model.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const TICK_MS = 60_000;
const POLL_MS = 60_000; // Without a live connection.
const LIVE_POLL_MS = 15 * 60_000; // A safety net while live.
const LIVE_GAP_MS = 5_000; // Playback sends many changes; refresh at most this often.
const UPDATE_CHECK_MS = 6 * 3_600_000;
const TABS = [["watching", "Watching"], ["upcoming", "Upcoming"], ["missing", "Missing"]];

const root = document.getElementById("app");
const toastEl = document.getElementById("toast");

const state = {
  session: null,
  settings: null,
  tab: "watching",
  shows: null,
  tmdb: new Map(),
  tmdbRaw: new Map(),
  tmdbError: null,
  error: null,
  updatedAt: null,
  filter: "",
  openId: null,
  season: null,
  justPlayed: null,
  keyMessage: "",
  live: false,
  ignored: {},
  update: null, // { version } when one is ready
  updateMessage: "",
  version: "",
};

const esc = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const image = (id, kind, query) => `${convertFileSrc(id, "jfimg")}/${kind}?${query}`;
const get = (path, query) => invoke("jf_get", { path, query });
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const hasKind = (error, kind) => error && error.kind === kind;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Small per-device memory for notifications. Losing it only means a repeat or a skipped alert.
const memory = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

/* The strip: one cell per episode, a wider gap between seasons. */
function strip(show, { large = false } = {}) {
  const eps = show.counted;
  if (!eps.length) return "";
  const dense = eps.length > 150;
  const step = dense ? 1 : 1.2;
  const seasonGap = dense ? 4 : 1.2;
  let x = 0;
  let last = eps[0].season;
  const cells = eps.map((ep) => {
    if (ep.season !== last) { x += seasonGap; last = ep.season; }
    const at = x;
    x += step;
    const label = `${esc(episodeLabel(ep))}, ${esc(ep.name)}`;
    const kind = ep.played ? "seen" : "todo";
    const fresh = ep.id === state.justPlayed ? " fresh" : "";
    const part = !ep.played && ep.percent > 0
      ? `<rect class="part" x="${at}" y="0" width="${(ep.percent / 100).toFixed(3)}" height="1"/>` : "";
    const title = eps.length <= 200 ? `<title>${label}</title>` : "";
    return `<rect class="${kind}${fresh}" x="${at}" y="0" width="1" height="1">${title}</rect>${part}`;
  }).join("");
  const width = x - (step - 1);
  const px = Math.round(width * (large ? 14 : 11));
  return `<svg class="strip${large ? " large" : ""}" style="--w:${px}px" viewBox="0 0 ${width} 1" preserveAspectRatio="none"
    role="img" aria-label="${show.watched} of ${show.total} episodes watched">${cells}</svg>`;
}

const badge = (show) =>
  show.fresh.length ? `<span class="badge">${show.fresh.length} new</span>` : "";

const poster = (show, size = 240) => `<button class="poster" data-action="open" aria-label="Show episodes of ${esc(show.title)}">
  <img src="${image(show.id, "Primary", `maxHeight=${size}`)}" alt="" loading="lazy" /></button>`;

function nextLine(show) {
  const ep = show.next;
  if (ep) {
    const left = show.resuming ? minutesLeft(ep) : null;
    return `${show.resuming ? "Resume" : "Next"} ${esc(episodeLabel(ep))}, ${esc(ep.name)}${left ? `, ${left} min left` : ""}`;
  }
  const info = state.tmdb.get(show.id);
  const coming = info?.upcoming?.[0];
  if (coming) {
    const day = dayLabel(airDay(coming)).replace(/^(Today|Tomorrow)$/, (w) => w.toLowerCase());
    const time = airTime(coming);
    return `${esc(episodeLabel(coming))} airs ${esc(day)}${time ? ` at ${esc(time)}` : ""}`;
  }
  if (info?.airing) return "Next air date not announced";
  return "Waiting for new episodes";
}

function row(show) {
  return `<article class="show${show.id === state.openId ? " open" : ""}" data-show="${esc(show.id)}">
    ${poster(show)}
    <div class="body">
      <h3><button class="title" data-action="open">${esc(show.title)}</button>${badge(show)}</h3>
      <p class="next">${nextLine(show)}</p>
      ${strip(show)}
      <p class="count">${show.watched} of ${show.total} watched<span>${esc(timeAgo(show.lastWatched))}</span></p>
    </div>
    <div class="actions">
      ${show.next ? `<button class="primary" data-action="played" data-episode="${esc(show.next.id)}">Mark ${esc(episodeLabel(show.next))} watched</button>
      <button data-action="jellyfin" data-item="${esc(show.next.id)}">Open in Jellyfin</button>` : ""}
    </div>
  </article>`;
}

function section(title, shows, extraClass = "") {
  if (!shows.length) return "";
  return `<section class="${extraClass}"><h2>${title}</h2>${shows.map(row).join("")}</section>`;
}

function detail(show) {
  const seasons = [...new Set(show.episodes.map((ep) => ep.season))].sort((a, b) => a - b);
  const season = seasons.includes(state.season) ? state.season : (show.next?.season ?? seasons.at(-1));
  const eps = show.episodes.filter((ep) => ep.season === season);
  const info = state.tmdb.get(show.id);
  const summary = show.remaining
    ? `${plural(show.remaining, "episode", "episodes")} left`
    : "All episodes watched";
  const missing = info?.missing?.length ? `, ${plural(info.missing.length, "aired episode isn't", "aired episodes aren't")} in Jellyfin` : "";
  return `<aside class="detail" aria-label="${esc(show.title)}">
    <header>
      <img class="backdrop" src="${image(show.id, "Backdrop", "maxWidth=900")}" alt="" />
      <button class="close" data-action="close" aria-label="Close episodes">×</button>
      <h2>${esc(show.title)}</h2>
      <p>${summary}${missing}</p>
      ${strip(show, { large: true })}
    </header>
    <div class="seasons" role="tablist" aria-label="Seasons">
      ${seasons.map((s) => `<button role="tab" aria-selected="${s === season}" data-action="season" data-season="${s}">${s === 0 ? "Specials" : `Season ${s}`}</button>`).join("")}
    </div>
    <ol class="episodes">
      ${eps.map((ep) => `<li class="${ep.played ? "seen" : ""}${ep.id === show.next?.id ? " up" : ""}">
        <button class="tick" role="switch" aria-checked="${ep.played}" aria-label="${esc(episodeLabel(ep))} watched"
          data-action="toggle" data-episode="${esc(ep.id)}" data-played="${ep.played}"></button>
        <span class="n">${ep.number ?? ""}</span>
        <span class="name">${esc(ep.name)}${show.fresh.includes(ep) ? ' <span class="badge">New</span>' : ""}</span>
        <button class="link" data-action="jellyfin" data-item="${esc(ep.id)}" aria-label="Open ${esc(ep.name)} in Jellyfin">Open</button>
      </li>`).join("")}
    </ol>
  </aside>`;
}

const notice = (title, text = "", action = "") =>
  `<div class="notice">${title ? `<h2>${title}</h2>` : ""}${text ? `<p>${text}</p>` : ""}${action}</div>`;

const keyNotice = () => notice(
  "Add a TMDB API key",
  "Air dates and missing episodes come from TMDB. A key is free with a TMDB account.",
  '<button class="primary" data-action="tab" data-tab="settings">Open settings</button>',
);

function viewWatching(shows) {
  const keep = (show) => !show.caughtUp || state.tmdb.get(show.id)?.airing !== false;
  const listed = shows.filter(keep);
  if (!listed.length) {
    return notice("Nothing in progress", "Watch an episode in Jellyfin and the show appears here.");
  }
  return section("Watching now", listed.filter((s) => s.next && s.active))
    + section("On hold", listed.filter((s) => s.next && !s.active), "hold")
    + section("Caught up", listed.filter((s) => !s.next), "caught");
}

function viewUpcoming(shows) {
  if (!state.settings?.tmdb) return keyNotice();
  const today = dayString();
  const days = new Map();
  const undated = [];
  for (const show of shows) {
    const info = state.tmdb.get(show.id);
    if (!info?.upcoming) continue;
    if (!info.upcoming.length && info.airing) undated.push(show);
    for (const ep of info.upcoming) {
      const day = airDay(ep);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push({ show, ep });
    }
  }
  if (!days.size && !undated.length) {
    return notice("Nothing scheduled", "None of the shows you follow have announced new episodes.");
  }
  const byTime = (a, b) => (a.ep.airstamp ?? "~").localeCompare(b.ep.airstamp ?? "~");
  const groups = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => `<section class="day">
    <h2>${esc(dayLabel(date, today))}</h2>
    ${items.sort(byTime).map(({ show, ep }) => `<article class="line timed" data-show="${esc(show.id)}">
      <span class="time">${esc(airTime(ep))}</span>
      ${poster(show, 120)}
      <div><h3><button class="title" data-action="open">${esc(show.title)}</button></h3>
      <p>${esc(episodeLabel(ep))}${ep.name ? `, ${esc(ep.name)}` : ""}</p></div>
    </article>`).join("")}
  </section>`).join("");
  const later = undated.length ? `<section class="day"><h2>Date not announced</h2>
    <p class="plain">${undated.map((s) => esc(s.title)).join(", ")}</p></section>` : "";
  return groups + later + '<p class="footnote">Times are from TVmaze, in your time zone. Episodes without a time use TMDB\'s air date in the country of broadcast.</p>';
}

function viewMissing(shows) {
  if (!state.settings?.tmdb) return keyNotice();
  const gaps = [];
  const unchecked = [];
  const ignored = [];
  for (const show of shows) {
    const info = state.tmdb.get(show.id);
    if (!show.tmdbId) unchecked.push([show, "Jellyfin has no TMDB ID for this show. Identify it in Jellyfin to fix this."]);
    else if (info?.error) unchecked.push([show, info.error]);
    else if (info?.numberingDiffers) unchecked.push([show, "Jellyfin numbers its episodes differently from TMDB."]);
    else {
      if (info?.missing?.length) gaps.push([show, info]);
      if (info?.ignoredByHand?.length || info?.ignoredEarlier?.length) ignored.push([show, info]);
    }
  }
  const list = gaps.length
    ? `<section><h2>Not in Jellyfin</h2>${gaps.map(([show, info]) => `<article class="line gap" data-show="${esc(show.id)}">
        ${poster(show, 120)}
        <div><h3><button class="title" data-action="open">${esc(show.title)}</button><span class="state">${info.airing ? "Airing" : "Ended"}</span></h3>
        <p>${plural(info.missing.length, "aired episode is", "aired episodes are")} missing: ${esc(episodeRanges(info.missing))}</p></div>
        <div class="buttons">
          <button data-action="copy" aria-label="Copy the missing episodes of ${esc(show.title)}">Copy list</button>
          <button data-action="ignore" aria-label="Ignore the missing episodes of ${esc(show.title)}">Ignore</button>
        </div>
      </article>`).join("")}</section>`
    : notice("No missing episodes", "Every aired episode of the shows you follow is in Jellyfin.").replace('class="notice"', 'class="notice compact"');
  const skipped = unchecked.length
    ? `<section class="hold"><h2>Couldn't check</h2>${unchecked.map(([show, why]) => `<article class="line" data-show="${esc(show.id)}">
        <div><h3><button class="title" data-action="open">${esc(show.title)}</button></h3><p>${esc(why)}</p></div>
      </article>`).join("")}</section>`
    : "";
  const hidden = ignored.length
    ? `<section class="hold"><h2>Ignored</h2>${ignored.map(([show, info]) => `<article class="line" data-show="${esc(show.id)}">
        <div><h3><button class="title" data-action="open">${esc(show.title)}</button></h3>
        ${info.ignoredByHand.length ? `<p>${esc(episodeRanges(info.ignoredByHand))}, ignored by you</p>` : ""}
        ${info.ignoredEarlier.length ? `<p>${esc(episodeRanges(info.ignoredEarlier))}, before the first episode on your server</p>` : ""}</div>
        ${info.ignoredByHand.length ? `<button data-action="restore" aria-label="Stop ignoring episodes of ${esc(show.title)}">Restore</button>` : ""}
      </article>`).join("")}</section>`
    : "";
  return list + skipped + hidden;
}

function viewSettings() {
  const s = state.settings;
  const check = (name, label) =>
    `<label class="check"><input type="checkbox" data-setting="${name}"${s[name] ? " checked" : ""} /> ${label}</label>`;
  const tmdb = s.tmdb
    ? `<p>Your TMDB API key is saved.</p><div class="row"><button data-action="clearkey">Remove key</button></div>`
    : `<form id="tmdbkey" class="row">
        <input name="key" type="password" placeholder="API key or read access token" aria-label="TMDB API key" spellcheck="false" />
        <button class="primary" type="submit">Save key</button>
      </form>
      <p class="error" role="alert">${esc(state.keyMessage)}</p>
      <button class="link-button" data-action="keypage">Get a free key on themoviedb.org</button>`;
  return `<div class="settings">
    <section><h2>TMDB</h2><p class="lead">Used for air dates and missing episodes.</p>${tmdb}</section>
    <section><h2>Missing episodes</h2>
      ${check("ignoreEarlier", "Ignore episodes from before the first one on my server")}
      <p class="lead">Useful when you delete episodes after watching them.</p>
    </section>
    <section><h2>When the window is closed</h2>
      ${check("tray", "Keep Interlude running in the tray")}
      ${check("autostart", "Start Interlude when Windows starts")}
    </section>
    <section><h2>Notifications</h2>
      ${check("notifyAdded", "A new episode of a show I follow is added to Jellyfin")}
      ${check("notifyAiring", "An episode of a show I follow airs")}
      <p class="lead">Notifications need Interlude running, in the window or the tray.</p>
    </section>
    <section><h2>Updates</h2>
      <p>Interlude ${esc(state.version)}${state.update ? `. Version ${esc(state.update.version)} is ready.` : ""}</p>
      <div class="row">${state.update
        ? '<button class="primary" data-action="installupdate">Restart to update</button>'
        : '<button data-action="checkupdate">Check for updates</button>'}</div>
      <p class="lead">${esc(state.updateMessage)}</p>
    </section>
    <section><h2>Jellyfin</h2>
      <p>Signed in as ${esc(state.session.userName)} on ${esc(state.session.server)}.</p>
      <div class="row"><button data-action="signout">Sign out</button></div>
    </section>
  </div>`;
}

function viewMain() {
  const needle = state.filter.trim().toLowerCase();
  const shows = (state.shows ?? []).filter((s) => s.title.toLowerCase().includes(needle));
  const open = (state.shows ?? []).find((s) => s.id === state.openId);
  const missingCount = (state.shows ?? []).filter((s) => state.tmdb.get(s.id)?.missing?.length).length;

  let content;
  if (state.tab === "settings") content = viewSettings();
  else if (state.shows === null && state.error) {
    content = notice(esc(state.error.message), "", '<button class="primary" data-action="refresh">Try again</button>');
  } else if (state.shows === null) content = notice("", "Loading your shows from Jellyfin");
  else if (!shows.length && state.shows.length) content = notice("", `No show matches "${esc(state.filter)}".`);
  else if (state.tab === "upcoming") content = viewUpcoming(shows);
  else if (state.tab === "missing") content = viewMissing(shows);
  else content = viewWatching(shows);

  const problem = state.error && state.shows ? state.error : state.tmdbError;
  const status = problem
    ? `<span class="warn">${esc(problem.message)}</span>`
    : state.live ? '<span class="live" title="Jellyfin sends changes as they happen">Live</span>'
    : state.updatedAt ? `Updated ${clock(state.updatedAt)}` : "";
  const banner = state.update
    ? `<div class="banner" role="status">Interlude ${esc(state.update.version)} is ready.
        <button class="primary" data-action="installupdate">Restart to update</button></div>`
    : "";

  const tabs = TABS.map(([id, label]) => `<button role="tab" aria-selected="${state.tab === id}" data-action="tab" data-tab="${id}">${label}${
    id === "missing" && missingCount ? ` <span class="count">${missingCount}</span>` : ""}</button>`).join("");

  return `<div class="shell${open ? " split" : ""}">
    <div class="main">
      <header class="top">
        <h1>Interlude</h1>
        <nav role="tablist" aria-label="Views">${tabs}</nav>
        <input id="filter" type="search" placeholder="Filter shows" aria-label="Filter shows" value="${esc(state.filter)}"${state.tab === "settings" ? " hidden" : ""} />
        <span class="status">${status}</span>
        <button data-action="refresh">Refresh</button>
        <button data-action="tab" data-tab="settings" aria-pressed="${state.tab === "settings"}">Settings</button>
      </header>
      ${banner}
      <div class="scroll">${content}</div>
    </div>
    ${open ? detail(open) : ""}
  </div>`;
}

function viewSignIn(lastServer, message = "") {
  const cells = Array.from({ length: 24 }, (_, i) => `<i style="--i:${i}"></i>`).join("");
  root.innerHTML = `<main class="signin">
    <div class="mark" aria-hidden="true">${cells}</div>
    <h1>Interlude</h1>
    <p>See where you are in every show on your Jellyfin server.</p>
    <form id="signin">
      <label>Server address<input name="url" required value="${esc(lastServer || "http://localhost:8096")}" autocomplete="url" spellcheck="false" /></label>
      <label>Username<input name="username" required autocomplete="username" spellcheck="false" autofocus /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" /></label>
      <p class="error" role="alert">${esc(message)}</p>
      <button class="primary" type="submit">Sign in</button>
    </form>
  </main>`;
  root.querySelector("#signin").addEventListener("submit", onSignIn);
}

function render() {
  if (!state.session) return;
  const filter = document.getElementById("filter");
  const hadFocus = document.activeElement === filter;
  const caret = filter?.selectionStart;
  const scroll = root.querySelector(".scroll")?.scrollTop ?? 0;
  const listScroll = root.querySelector(".detail")?.scrollTop ?? 0;
  root.innerHTML = viewMain();
  root.querySelector(".scroll").scrollTop = scroll;
  const aside = root.querySelector(".detail");
  if (aside) aside.scrollTop = listScroll;
  const input = document.getElementById("filter");
  input.addEventListener("input", (e) => { state.filter = e.target.value; render(); });
  if (hadFocus) { input.focus(); input.setSelectionRange(caret, caret); }
  root.querySelector("#tmdbkey")?.addEventListener("submit", onSaveKey);
  root.querySelectorAll("[data-setting]").forEach((box) => box.addEventListener("change", onSetting));
}

async function loadTmdb() {
  if (!state.settings?.tmdb) { state.tmdb = new Map(); state.tmdbError = null; return; }
  const results = new Map();
  const raw = new Map();
  let failure = null;
  const ignoreEarlier = state.settings.ignoreEarlier;
  const shows = state.shows ?? [];
  for (let i = 0; i < shows.length; i += 4) {
    await Promise.all(shows.slice(i, i + 4).map(async (show) => {
      if (!show.tmdbId) return;
      try {
        const ignored = new Set(state.ignored[show.id] ?? []);
        const info = await invoke("tmdb_show", { id: show.tmdbId });
        raw.set(show.id, info);
        results.set(show.id, compareWithTmdb(show, info, { ignored, ignoreEarlier }));
      } catch (error) {
        results.set(show.id, { error: error.message });
        if (hasKind(error, "tmdbauth") || hasKind(error, "network")) failure = error;
      }
    }));
  }
  state.tmdb = results;
  state.tmdbRaw = raw;
  state.tmdbError = failure;
}

const alert = (title, body) => invoke("notify", { title, body }).catch(() => {});

function notifyAdded() {
  const shows = state.shows ?? [];
  const newest = Math.max(0, ...shows.flatMap((s) => s.episodes.map((e) => e.added)));
  const since = memory.get("addedSince", null);
  memory.set("addedSince", Math.max(since ?? 0, newest || Date.now()));
  if (since === null || !state.settings?.notifyAdded) return; // The first run sets the baseline.
  for (const show of shows) {
    const eps = show.counted.filter((ep) => !ep.played && ep.added > since);
    if (eps.length === 1) alert(show.title, `${episodeLabel(eps[0])}, ${eps[0].name} is ready to watch.`);
    else if (eps.length > 1) alert(show.title, `${eps.length} new episodes are ready to watch.`);
  }
}

// With an exact time: when it airs. With only a date: once that day.
function notifyAiring() {
  if (!state.settings?.notifyAiring) return;
  const now = Date.now();
  const today = dayString();
  const sent = Object.fromEntries(Object.entries(memory.get("airedSent", {})).filter(([, at]) => now - at < 3 * 86_400_000));
  const recently = 6 * 3_600_000;
  for (const show of state.shows ?? []) {
    const info = state.tmdbRaw.get(show.id);
    if (!info) continue;
    for (const ep of [...(info.episodes ?? []), ...(info.next ? [info.next] : [])]) {
      const key = `${show.id}:${ep.season}:${ep.number}`;
      if (sent[key] || ep.season < 1) continue;
      const name = ep.name ? `, ${ep.name},` : "";
      if (ep.airstamp && hasAired(ep, now) && now - Date.parse(ep.airstamp) < recently) {
        alert(show.title, `${episodeLabel(ep)}${name} is airing now.`);
        sent[key] = now;
      } else if (!ep.airstamp && ep.airDate === today) {
        alert(show.title, `${episodeLabel(ep)}${name} airs today.`);
        sent[key] = now;
      }
    }
  }
  memory.set("airedSent", sent);
}

let loading = false;
let again = false;
async function refresh() {
  if (!state.session) return;
  if (loading) { again = true; return; }
  loading = true;
  try {
    state.shows = await loadShows(get, state.session.userId);
    state.error = null;
    state.updatedAt = Date.now();
    render();
    await loadTmdb();
    notifyAdded();
    notifyAiring();
  } catch (error) {
    if (hasKind(error, "auth")) { loading = false; return endSession(error.message); }
    state.error = error;
  }
  loading = false;
  render();
  if (again) { again = false; refresh(); }
}

// Live changes arrive in bursts (playback reports progress often), so refresh at most every few seconds.
let liveTimer = null;
let lastLiveRefresh = 0;
function refreshSoon() {
  if (liveTimer) return;
  const wait = Math.max(0, lastLiveRefresh + LIVE_GAP_MS - Date.now());
  liveTimer = setTimeout(() => {
    liveTimer = null;
    lastLiveRefresh = Date.now();
    refresh();
  }, wait);
}

async function checkUpdate({ quiet = true } = {}) {
  try {
    state.update = await invoke("check_update");
    state.updateMessage = state.update || quiet ? "" : "You have the latest version.";
  } catch (error) {
    state.updateMessage = quiet ? "" : error.message;
  }
  render();
}

async function endSession(message) {
  state.session = null;
  state.shows = null;
  state.openId = null;
  state.error = null;
  state.tab = "watching";
  viewSignIn(await invoke("last_server"), message);
}

function toast(text, undo) {
  toastEl.innerHTML = `<span>${esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
  toastEl.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove("on"), 6000);
  toastEl.querySelector("button")?.addEventListener("click", () => {
    toastEl.classList.remove("on");
    undo();
  });
}

const findEpisode = (id) => {
  for (const show of state.shows ?? []) {
    const ep = show.episodes.find((e) => e.id === id);
    if (ep) return ep;
  }
};

async function setPlayed(id, played) {
  const ep = findEpisode(id);
  try {
    await invoke("set_played", { itemId: id, played });
  } catch (error) {
    if (hasKind(error, "auth")) return endSession(error.message);
    return toast(error.message);
  }
  state.justPlayed = played ? id : null;
  await refresh();
  state.justPlayed = null;
  if (ep) {
    toast(`${episodeLabel(ep)} marked ${played ? "watched" : "unwatched"}`, () => setPlayed(id, !played));
  }
}

async function saveSettings(change) {
  const { tmdb, autostart, ...settings } = { ...state.settings, ...change };
  try {
    await invoke("set_settings", { settings, autostart });
  } catch (error) {
    toast(error.message);
  }
  state.settings = await invoke("get_settings");
  if ("ignoreEarlier" in change) await loadTmdb();
  render();
}

function onSetting(event) {
  saveSettings({ [event.target.dataset.setting]: event.target.checked });
}

async function onSaveKey(event) {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking key";
  try {
    await invoke("set_tmdb_key", { key: new FormData(event.target).get("key") });
    state.keyMessage = "";
    state.settings = await invoke("get_settings");
    toast("TMDB key saved");
    render();
    refresh();
  } catch (error) {
    state.keyMessage = error.message;
    render();
  }
}

async function saveIgnored(id, keys, message) {
  const before = state.ignored[id] ?? [];
  try {
    await invoke("set_ignored", { seriesId: id, episodes: keys });
  } catch (error) {
    return toast(error.message);
  }
  state.ignored = await invoke("get_ignored");
  await loadTmdb();
  render();
  toast(message, () => saveIgnored(id, before, "Change undone"));
}

async function copyMissing(showId) {
  const show = state.shows.find((s) => s.id === showId);
  const info = state.tmdb.get(showId);
  const code = (ep) => `S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`;
  const text = info.missing.map((ep) => `${show.title} ${code(ep)}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${plural(info.missing.length, "episode", "episodes")} of ${show.title}`);
  } catch {
    toast("Couldn't copy to the clipboard.");
  }
}

const actions = {
  open(el) {
    state.openId = el.closest("[data-show]").dataset.show;
    state.season = null;
    render();
    root.querySelector(".close")?.focus();
  },
  close() { state.openId = null; render(); },
  season(el) { state.season = Number(el.dataset.season); render(); },
  tab(el) { state.tab = el.dataset.tab; state.openId = null; root.querySelector(".scroll").scrollTop = 0; render(); },
  played(el) { el.disabled = true; setPlayed(el.dataset.episode, true); },
  toggle(el) { el.disabled = true; setPlayed(el.dataset.episode, el.dataset.played !== "true"); },
  jellyfin(el) { invoke("open_in_jellyfin", { itemId: el.dataset.item }).catch((e) => toast(e.message)); },
  copy(el) { copyMissing(el.closest("[data-show]").dataset.show); },
  ignore(el) {
    const id = el.closest("[data-show]").dataset.show;
    const info = state.tmdb.get(id);
    const keys = [...new Set([...(state.ignored[id] ?? []), ...info.missing.map(episodeKey)])];
    saveIgnored(id, keys, `Ignored ${plural(info.missing.length, "episode", "episodes")} of ${state.shows.find((s) => s.id === id).title}`);
  },
  restore(el) {
    const id = el.closest("[data-show]").dataset.show;
    saveIgnored(id, [], `Stopped ignoring episodes of ${state.shows.find((s) => s.id === id).title}`);
  },
  checkupdate(el) { el.disabled = true; state.updateMessage = "Checking"; checkUpdate({ quiet: false }); },
  async installupdate(el) {
    el.disabled = true;
    el.textContent = "Updating";
    try {
      await invoke("install_update"); // Interlude restarts when this succeeds.
    } catch (error) {
      toast(error.message);
      render();
    }
  },
  keypage() { invoke("open_tmdb_key_page").catch((e) => toast(e.message)); },
  async clearkey() {
    await invoke("clear_tmdb_key");
    state.settings = await invoke("get_settings");
    state.tmdb = new Map();
    render();
  },
  refresh() { refresh(); },
  async signout() {
    await invoke("sign_out");
    endSession("");
  },
};

root.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (el) actions[el.dataset.action](el);
});

// Shows without artwork keep the plain tile instead of a broken image.
root.addEventListener("error", (event) => { if (event.target.tagName === "IMG") event.target.hidden = true; }, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.openId) { state.openId = null; render(); }
});

async function onSignIn(event) {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const submit = form.querySelector("button");
  const message = form.querySelector(".error");
  submit.disabled = true;
  submit.textContent = "Signing in";
  message.textContent = "";
  try {
    await invoke("server_info", { url: data.url });
    state.session = await invoke("sign_in", data);
    render();
    refresh();
    if (!state.session.remembered) toast("Couldn't save your sign-in. You'll need to sign in again next time.");
  } catch (error) {
    message.textContent = error.message;
    submit.disabled = false;
    submit.textContent = "Sign in";
  }
}

async function start() {
  state.settings = await invoke("get_settings");
  state.ignored = await invoke("get_ignored");
  state.version = await invoke("app_version");
  state.live = await invoke("live_connected");
  state.session = await invoke("current_session");
  if (!state.session) return viewSignIn(await invoke("last_server"));
  render();
  refresh();
}

listen("jellyfin-changed", refreshSoon);
listen("live-status", (event) => { state.live = event.payload; render(); });

// Each minute: poll if there's no live connection (or as a rare safety net), and check air times.
setInterval(() => {
  const since = Date.now() - (state.updatedAt ?? 0);
  if (since >= (state.live ? LIVE_POLL_MS : POLL_MS)) refresh();
  else notifyAiring();
}, TICK_MS);
window.addEventListener("focus", () => { if (!state.live) refresh(); });

setTimeout(checkUpdate, 10_000);
setInterval(checkUpdate, UPDATE_CHECK_MS);
start();
