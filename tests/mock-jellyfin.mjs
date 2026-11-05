// Stand-ins for Jellyfin (with its live socket), TMDB, TVmaze and the update feed, for
// testing. Jellyfin routes and messages follow the official @jellyfin/sdk; TMDB its v3 API.
// Run: node tests/mock-jellyfin.mjs   (Jellyfin user demo / demo, TMDB key "good-key")
// Start a debug build with:
//   INTERLUDE_TMDB_URL=http://localhost:8096/3 INTERLUDE_TVMAZE_URL=http://localhost:8096/tvmaze
//   INTERLUDE_UPDATE_URL=http://localhost:8096/update/latest.json INTERLUDE_ANILIST_URL=http://localhost:8096/anilist
// POST /mock/add-episode adds an episode to the first show and tells live clients.
import http from "node:http";
import crypto from "node:crypto";

const TOKEN = "mock-token";
const TMDB_KEY = "good-key";
const now = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const day = (offset) => {
  const d = new Date(now + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const hex = (n) => n.toString(16).padStart(32, "0");

// jf: episodes per season in Jellyfin. tmdb: [season, episode, days from today] lists.
const seq = (season, count, startOffset, step = 7) =>
  Array.from({ length: count }, (_, i) => [season, i + 1, startOffset + i * step]);
const shows = [
  { id: hex(1), name: "Sōsō no Frieren", tmdbId: 209867, anilist: { series: 154587, seasons: { 1: 154587, 2: 182255 } }, status: "Continuing", jf: [28, 10], watched: 33, days: 1, resume: 34,
    addedRecently: 2, tmdbStatus: "Returning Series", tmdb: [...seq(1, 28, -700), ...seq(2, 12, -68)] },
  { id: hex(2), name: "Severance", tmdbId: 95396, status: "Continuing", jf: [9, 8], watched: 12, days: 4,
    tmdbStatus: "Returning Series", tmdb: [...seq(1, 9, -1000), ...seq(2, 10, -300)] },
  { id: hex(3), name: "One Piece", tmdbId: 37854, status: "Continuing", jf: [320, 280, 240, 260], watched: 640, days: 12,
    tmdbStatus: "Returning Series", tmdb: seq(1, 1150, -9000, 7) },
  { id: hex(4), name: "Slow Horses", tmdbId: 95480, status: "Continuing", jf: [6, 6, 6], watched: 7, days: 95,
    tmdbStatus: "Returning Series", tmdb: [...seq(1, 6, -1200), ...seq(2, 6, -800), ...seq(3, 6, -400), ...seq(4, 6, 20)] },
  { id: hex(5), name: "Mushishi", tmdbId: null, status: "Ended", jf: [26], watched: 5, days: 210 },
  { id: hex(6), name: "Dandadan", tmdbId: 240411, airsSoon: true, status: "Continuing", jf: [12], watched: 12, days: 40,
    tmdbStatus: "Returning Series", tmdb: [...seq(1, 12, -400), ...seq(2, 12, 0)] },
  // Anime with no TMDB ID: only AniList can check it. Season 2 is missing episodes 7 and 8.
  { id: hex(8), name: "The Apothecary Diaries", tmdbId: null, anilist: { series: 161645, seasons: { 1: 161645, 2: 177709 } },
    status: "Continuing", jf: [24, 6], watched: 28, days: 6 },
  { id: hex(7), name: "Pluribus", tmdbId: 225171, status: "Continuing", jf: [9], watched: 9, days: 20,
    tmdbStatus: "Ended", tmdb: seq(1, 9, -60) },
];

const episodes = new Map();
let next = 100;
for (const show of shows) {
  const list = [];
  const total = show.jf.reduce((a, b) => a + b, 0);
  show.jf.forEach((count, s) => {
    for (let e = 1; e <= count; e++) {
      const index = list.length + 1;
      const played = index <= show.watched;
      const resuming = index === show.resume;
      const recent = show.addedRecently && index > total - show.addedRecently;
      list.push({
        Id: hex(next++), Type: "Episode", Name: `Episode title ${index}`,
        SeriesId: show.id, SeriesName: show.name,
        ParentIndexNumber: s + 1, IndexNumber: e, RunTimeTicks: 14_400_000_000,
        DateCreated: iso(recent ? now - 2 * HOUR : now - 900 * DAY),
        UserData: {
          Played: played,
          PlayedPercentage: resuming ? 45 : undefined,
          PlaybackPositionTicks: resuming ? 6_480_000_000 : 0,
          LastPlayedDate: played || resuming ? iso(now - (show.days + (show.watched - index) * 0.01) * DAY) : undefined,
        },
      });
    }
  });
  episodes.set(show.id, list);
}

const nextUp = () => [...episodes.values()].flatMap((list) => {
  const first = list.findIndex((e) => !e.UserData.Played);
  return first > 0 && !list[first].UserData.PlaybackPositionTicks ? [list[first]] : [];
});
const resume = () => [...episodes.values()].flat().filter((e) => e.UserData.PlaybackPositionTicks > 0);
const seriesItem = (show) => ({
  Id: show.id, Name: show.name, Type: "Series", Status: show.status,
  ProviderIds: { ...(show.tmdbId ? { Tmdb: String(show.tmdbId) } : {}), ...(show.anilist ? { AniList: String(show.anilist.series) } : {}) },
  UserData: { Played: episodes.get(show.id).every((e) => e.UserData.Played) },
});

const svg = (id) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#${id.slice(-3)}a6e"/></svg>`;

// TVmaze: the same episodes with exact times. Dandadan's next episode airs 70 seconds after start.
const startedAt = Date.now();
function tvmaze(url, res, send) {
  const lookup = url.pathname === "/tvmaze/lookup/shows" && shows.find((s) => s.tmdbId && String(s.tmdbId + 1000) === url.searchParams.get("thetvdb"));
  if (lookup) { res.writeHead(302, { location: `/tvmaze/shows/${lookup.tmdbId}` }); return res.end(); }
  const show = shows.find((s) => s.tmdbId && url.pathname.startsWith(`/tvmaze/shows/${s.tmdbId}`));
  if (!show) return send(404, { name: "Not Found" });
  if (!url.pathname.endsWith("/episodes")) return send(200, { id: show.tmdbId, name: show.name });
  return send(200, show.tmdb.map(([season, number, offset]) => {
    const date = day(offset);
    let stamp = new Date(`${date}T13:00:00Z`).toISOString();
    if (show.airsSoon && offset === 0) stamp = new Date(startedAt + 70_000).toISOString();
    return { season, number, name: `TVmaze ${season}x${number}`, airdate: date, airstamp: stamp };
  }));
}

// AniList: Frieren season 2 airs weekly with episode 11 next; Apothecary Diaries season 2
// has aired 8 of 24 (Jellyfin has 6), episode 9 airs in 4 days.
const H = 3600;
const nowSec = Math.floor(Date.now() / 1000);
const anilistMedia = {
  154587: { status: "FINISHED", episodes: 28, schedule: [] },
  182255: { status: "RELEASING", episodes: 12, next: 11, nextAt: nowSec + 2 * 24 * H },
  161645: { status: "FINISHED", episodes: 24, schedule: [] },
  177709: { status: "RELEASING", episodes: 24, next: 9, nextAt: nowSec + 4 * 24 * H },
};
function anilist(req, send) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(body);
    if (!query.includes("airingSchedules")) return send(400, { errors: [{ message: "bad query" }] });
    const ids = variables.ids;
    const media = ids.filter((id) => anilistMedia[id]).map((id) => {
      const m = anilistMedia[id];
      return { id, status: m.status, episodes: m.episodes, nextAiringEpisode: m.next ? { episode: m.next, airingAt: m.nextAt } : null };
    });
    const schedule = [];
    for (const id of ids) {
      const m = anilistMedia[id];
      if (!m?.next) continue;
      for (let n = m.next - 1; n <= m.episodes; n++) {
        const at = m.nextAt + (n - m.next) * 7 * 24 * H;
        if (at > variables.since && at < variables.until) schedule.push({ mediaId: id, episode: n, airingAt: at });
      }
    }
    schedule.sort((a, b) => a.airingAt - b.airingAt);
    const page = variables.page ?? 1;
    send(200, { data: {
      entries: { media },
      schedule: { pageInfo: { hasNextPage: schedule.length > page * 50 }, airingSchedules: schedule.slice((page - 1) * 50, page * 50) },
    } });
  });
}

function tmdb(url, req, send) {
  const key = url.searchParams.get("api_key") ?? (req.headers.authorization ?? "").replace("Bearer ", "");
  if (key !== TMDB_KEY) return send(401, { status_code: 7, status_message: "Invalid API key" });
  if (url.pathname === "/3/configuration") return send(200, { images: {} });
  const match = url.pathname.match(/^\/3\/tv\/(\d+)$/);
  const show = match && shows.find((s) => s.tmdbId === Number(match[1]));
  if (!show) return send(404, { status_code: 34 });
  const seasons = [...new Set(show.tmdb.map(([s]) => s))];
  const ep = ([s, e, offset]) => ({ season_number: s, episode_number: e, name: `TMDB episode ${s}x${e}`, air_date: day(offset) });
  const upcoming = show.tmdb.filter(([, , o]) => o >= 0).sort((a, b) => a[2] - b[2])[0];
  const body = {
    id: show.tmdbId, name: show.name, status: show.tmdbStatus,
    external_ids: { tvdb_id: show.tmdbId + 1000, imdb_id: null },
    next_episode_to_air: upcoming ? ep(upcoming) : null,
    seasons: [{ season_number: 0, episode_count: 1 }, ...seasons.map((s) => ({ season_number: s, episode_count: show.tmdb.filter(([x]) => x === s).length }))],
  };
  for (const part of (url.searchParams.get("append_to_response") ?? "").split(",").filter((p) => p.startsWith("season/"))) {
    const n = Number(part.split("/")[1]);
    body[part] = { season_number: n, episodes: show.tmdb.filter(([s]) => s === n).map(ep) };
  }
  send(200, body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  const auth = req.headers.authorization ?? "";
  console.log(req.method, url.pathname + url.search);

  if (url.pathname.startsWith("/3/")) return tmdb(url, req, send);
  if (url.pathname.startsWith("/tvmaze/")) return tvmaze(url, res, send);
  if (url.pathname === "/anilist") return anilist(req, send);
  if (url.pathname === "/update/latest.json") {
    return send(200, {
      version: "0.3.0", notes: "Test update", pub_date: "2026-11-05T00:00:00Z",
      platforms: Object.fromEntries(["linux-x86_64", "windows-x86_64"].map((p) => [p, { signature: "test", url: "http://localhost:8096/update/file" }])),
    });
  }
  if (url.pathname === "/mock/add-episode") {
    const show = shows[0];
    const list = episodes.get(show.id);
    const last = list.at(-1);
    list.push({ ...structuredClone(last), Id: hex(next++), IndexNumber: last.IndexNumber + 1, Name: "Freshly added episode",
      DateCreated: new Date().toISOString(), UserData: { Played: false, PlaybackPositionTicks: 0 } });
    broadcast({ MessageType: "LibraryChanged", Data: { ItemsAdded: [list.at(-1).Id] } });
    return send(200, { added: list.at(-1).Id });
  }
  if (url.pathname === "/System/Info/Public") return send(200, { ServerName: "mock", Version: "10.11.0" });
  if (url.pathname === "/Users/AuthenticateByName") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { Username, Pw } = JSON.parse(body);
      if (!auth.startsWith("MediaBrowser ") || !auth.includes('Client="Interlude"')) return send(400);
      if (Username !== "demo" || Pw !== "demo") return send(401);
      send(200, { AccessToken: TOKEN, User: { Id: hex(9), Name: "demo" } });
    });
    return;
  }
  if (!auth.includes(`Token="${TOKEN}"`)) return send(401);

  const image = url.pathname.match(/^\/Items\/(\w+)\/Images\/\w+$/);
  if (image) { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(svg(image[1])); }
  if (url.pathname === "/Items") {
    const ids = url.searchParams.get("ids");
    let list = shows.map(seriesItem);
    if (ids) list = list.filter((s) => ids.split(",").includes(s.Id));
    if (url.searchParams.get("filters") === "IsPlayed") list = list.filter((s) => s.UserData.Played);
    return send(200, { Items: list });
  }
  if (url.pathname === "/Shows/NextUp") return send(200, { Items: nextUp() });
  const seasons = url.pathname.match(/^\/Shows\/(\w+)\/Seasons$/);
  if (seasons) {
    const show = shows.find((s) => s.id === seasons[1]);
    return send(200, { Items: show.jf.map((_, i) => ({
      Id: hex(5000 + i), IndexNumber: i + 1, Name: `Season ${i + 1}`,
      ProviderIds: show.anilist?.seasons?.[i + 1] ? { AniList: String(show.anilist.seasons[i + 1]) } : {},
    })) });
  }
  if (url.pathname === "/UserItems/Resume") return send(200, { Items: resume() });
  const eps = url.pathname.match(/^\/Shows\/(\w+)\/Episodes$/);
  if (eps) return send(200, { Items: episodes.get(eps[1]) ?? [] });
  const played = url.pathname.match(/^\/UserPlayedItems\/(\w+)$/);
  if (played) {
    const ep = [...episodes.values()].flat().find((e) => e.Id === played[1]);
    if (!ep) return send(404);
    ep.UserData.Played = req.method === "POST";
    ep.UserData.PlaybackPositionTicks = 0;
    ep.UserData.PlayedPercentage = undefined;
    ep.UserData.LastPlayedDate = new Date().toISOString();
    broadcast({ MessageType: "UserDataChanged", Data: { UserId: hex(9), UserDataList: [ep.UserData] } });
    return send(200, ep.UserData);
  }
  if (url.pathname === "/Sessions/Logout") return send(204);
  send(404);
});

// Minimal WebSocket server for /socket (RFC 6455 text frames only).
const sockets = new Set();
const frame = (text) => {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
};
function broadcast(message) {
  console.log("LIVE ->", message.MessageType, "to", sockets.size);
  for (const socket of sockets) socket.write(frame(JSON.stringify(message)));
}
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/socket" || url.searchParams.get("ApiKey") !== TOKEN) {
    console.log("LIVE rejected", url.pathname);
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  console.log("LIVE connected");
  socket.write(frame(JSON.stringify({ MessageType: "ForceKeepAlive", Data: 6 })));
  socket.on("data", (buf) => {
    const opcode = buf[0] & 15;
    if (opcode === 8) return socket.end();
    const len = buf[1] & 127;
    const offset = len === 126 ? 4 : 2;
    const size = len === 126 ? buf.readUInt16BE(2) : len;
    const mask = buf.subarray(offset, offset + 4);
    const data = Buffer.from(buf.subarray(offset + 4, offset + 4 + size).map((b, i) => b ^ mask[i % 4]));
    if (opcode === 1) console.log("LIVE <-", data.toString());
  });
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});
server.listen(8096, () => console.log("mock Jellyfin, TMDB, TVmaze and updates on :8096"));
