// Turns Jellyfin's Next Up, Resume and episode lists into the shows on screen,
// then compares each show with TMDB for air dates and missing episodes.
// Interlude stores no watch data of its own.

const DAY = 86_400_000;
const TICKS_PER_MINUTE = 600_000_000;
export const ACTIVE_DAYS = 30;
const UPCOMING_PER_SHOW = 3;

const pad = (n) => String(n).padStart(2, "0");
export const dayString = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const episodeFrom = (item) => ({
  id: item.Id,
  name: item.Name ?? "Untitled episode",
  season: item.ParentIndexNumber ?? 1,
  number: item.IndexNumber ?? null,
  played: Boolean(item.UserData?.Played),
  percent: item.UserData?.PlayedPercentage ?? 0,
  positionTicks: item.UserData?.PlaybackPositionTicks ?? 0,
  runtimeTicks: item.RunTimeTicks ?? 0,
  lastPlayed: item.UserData?.LastPlayedDate ? Date.parse(item.UserData.LastPlayedDate) : 0,
  added: item.DateCreated ? Date.parse(item.DateCreated) : 0,
});

export const episodeLabel = (ep) =>
  ep.number == null ? `S${ep.season}` : `S${ep.season} E${ep.number}`;

export function minutesLeft(ep) {
  if (!ep.runtimeTicks || !ep.positionTicks) return null;
  return Math.max(1, Math.round((ep.runtimeTicks - ep.positionTicks) / TICKS_PER_MINUTE));
}

// A partly watched episode comes before the next unwatched one.
export function buildShow(seriesId, title, nextItem, resumeItem, episodeItems, info = {}, now = Date.now()) {
  const episodes = episodeItems
    .filter((item) => item.Type === undefined || item.Type === "Episode")
    .map(episodeFrom);
  const counted = episodes.filter((ep) => ep.season > 0); // Season 0 holds specials.
  const watched = counted.filter((ep) => ep.played).length;
  const lastWatched = Math.max(0, ...episodes.map((ep) => ep.lastPlayed));

  const pick = (item) =>
    item && (episodes.find((ep) => ep.id === item.Id) ?? episodeFrom(item));
  const resuming = pick(resumeItem);
  const next = resuming ?? pick(nextItem) ?? null;
  const fresh = lastWatched
    ? counted.filter((ep) => !ep.played && ep.added > lastWatched)
    : [];

  return {
    id: seriesId,
    title,
    tmdbId: Number(info.ProviderIds?.Tmdb) || null,
    episodes,
    counted,
    total: counted.length,
    watched,
    remaining: counted.length - watched,
    next,
    resuming: Boolean(resuming),
    caughtUp: !next && counted.length > 0 && watched === counted.length,
    fresh,
    lastWatched,
    active: lastWatched > 0 && now - lastWatched <= ACTIVE_DAYS * DAY,
  };
}

async function inBatches(items, size, work) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  }
  return results;
}

export async function loadShows(get, userId, now = Date.now()) {
  const user = [["userId", userId], ["enableUserData", "true"], ["enableImages", "false"]];
  const [nextUp, resume, finished] = await Promise.all([
    get("/Shows/NextUp", [
      ...user,
      ["limit", "100"],
      ["enableResumable", "false"],
      ["enableRewatching", "false"],
      ["disableFirstEpisode", "true"],
    ]),
    get("/UserItems/Resume", [
      ...user,
      ["limit", "100"],
      ["includeItemTypes", "Episode"],
      ["mediaTypes", "Video"],
    ]),
    // Fully watched shows that Jellyfin marks as still running.
    get("/Items", [
      ...user,
      ["includeItemTypes", "Series"],
      ["recursive", "true"],
      ["filters", "IsPlayed"],
      ["fields", "ProviderIds,Status"],
    ]),
  ]);

  const series = new Map();
  const slot = (id, title) => {
    if (!id) return null;
    if (!series.has(id)) series.set(id, { title: title ?? "Unknown show", next: null, resume: null, info: null });
    return series.get(id);
  };
  for (const item of nextUp.Items ?? []) {
    const entry = slot(item.SeriesId, item.SeriesName);
    if (entry) entry.next = item;
  }
  for (const item of resume.Items ?? []) {
    const entry = slot(item.SeriesId, item.SeriesName);
    if (entry && !entry.resume) entry.resume = item;
  }

  // Provider IDs for the shows in progress, so they can be matched on TMDB.
  const inProgress = [...series.keys()];
  if (inProgress.length) {
    const infos = await get("/Items", [...user, ["ids", inProgress.join(",")], ["fields", "ProviderIds"]]);
    for (const info of infos.Items ?? []) {
      if (series.has(info.Id)) series.get(info.Id).info = info;
    }
  }
  for (const item of finished.Items ?? []) {
    if (item.Status === "Continuing" && !series.has(item.Id)) {
      slot(item.Id, item.Name).info = item;
    }
  }

  const shows = await inBatches([...series], 4, async ([id, entry]) => {
    const episodes = await get(`/Shows/${id}/Episodes`, [...user, ["isMissing", "false"], ["fields", "DateCreated"]]);
    const show = buildShow(id, entry.title, entry.next, entry.resume, episodes.Items ?? [], entry.info ?? {}, now);
    if (anilistId(entry.info?.ProviderIds)) {
      const seasons = await get(`/Shows/${id}/Seasons`, [...user, ["fields", "ProviderIds"]]);
      show.anilist = anilistSeasons(entry.info.ProviderIds, seasons.Items ?? []);
    }
    return show;
  });
  return shows.sort((a, b) => b.lastWatched - a.lastWatched);
}

/** The AniList ID a metadata plugin stored on an item, whatever the key's capitalisation. */
export function anilistId(providerIds) {
  const entry = Object.entries(providerIds ?? {}).find(([key]) => key.toLowerCase() === "anilist");
  return Number(entry?.[1]) || null;
}

/**
 * Which AniList entry each Jellyfin season matches: season-level IDs when the plugin set them,
 * otherwise the show's ID for a show with a single season. Null when it can't tell.
 */
export function anilistSeasons(seriesIds, seasonItems) {
  const regular = seasonItems.filter((s) => (s.IndexNumber ?? 0) > 0);
  const mapping = {};
  for (const season of regular) {
    const id = anilistId(season.ProviderIds);
    if (id) mapping[season.IndexNumber] = id;
  }
  if (!Object.keys(mapping).length && regular.length === 1) mapping[regular[0].IndexNumber] = anilistId(seriesIds);
  return Object.keys(mapping).length ? mapping : null;
}

const AIRING = new Set(["Returning Series", "In Production", "Planned", "Pilot"]);

export const episodeKey = (ep) => `${ep.season}:${ep.number}`;

/** The local calendar day an episode airs: from TVmaze's exact time when known, else TMDB's date. */
export const airDay = (ep) => (ep.airstamp ? dayString(new Date(ep.airstamp)) : ep.airDate);

/** With an exact time, aired once that time passes; with only a date, from the next day. */
export function hasAired(ep, now = Date.now(), today = dayString(new Date(now))) {
  if (ep.airstamp) return Date.parse(ep.airstamp) <= now;
  return Boolean(ep.airDate) && ep.airDate < today;
}

/** Time for an episode that has aired to reach the server before it counts as missing. */
export const MISSING_AFTER_MS = DAY;

/** Past its grace period: missing if not in Jellyfin. Before that it still shows as upcoming. */
function settled(ep, now, today) {
  if (ep.airstamp) return Date.parse(ep.airstamp) + MISSING_AFTER_MS <= now;
  return Boolean(ep.airDate) && ep.airDate < today;
}

const byEpisode = (a, b) => a.season - b.season || a.number - b.number;

/**
 * What TMDB knows that Jellyfin doesn't: upcoming air dates and aired episodes
 * that aren't in the library. When Jellyfin numbers episodes differently
 * (common with anime), the missing list would be wrong, so it's withheld.
 * Missing episodes from before the first one on the server can be ignored
 * automatically; others can be ignored by hand (the `ignored` set of keys).
 */
export function compareWithTmdb(show, tmdb, { now = Date.now(), ignored = new Set(), ignoreEarlier = true } = {}) {
  const today = dayString(new Date(now));
  const inJellyfin = new Set(show.counted.map(episodeKey));
  const listed = (tmdb.episodes ?? []).filter((ep) => ep.season > 0 && ep.number != null);
  const onTmdb = new Set(listed.map(episodeKey));
  const numberingDiffers = show.counted.some((ep) => !onTmdb.has(episodeKey(ep)));

  const gaps = numberingDiffers
    ? []
    : listed.filter((ep) => settled(ep, now, today) && !inJellyfin.has(episodeKey(ep))).sort(byEpisode);
  const split = splitGaps(show, gaps, ignored, ignoreEarlier);

  let upcoming = listed.filter((ep) => (ep.airstamp || ep.airDate) && !settled(ep, now, today) && !inJellyfin.has(episodeKey(ep)));
  const next = tmdb.next;
  if (next && (next.airstamp || next.airDate) && !settled(next, now, today) && !upcoming.some((ep) => episodeKey(ep) === episodeKey(next))) {
    upcoming.push(next);
  }
  return {
    source: "TMDB",
    airing: AIRING.has(tmdb.status),
    status: tmdb.status ?? "Unknown",
    upcoming: soonest(upcoming),
    ...split,
    numberingDiffers,
  };
}

const soonest = (eps) => eps
  .sort((a, b) => airDay(a).localeCompare(airDay(b)) || (a.airstamp ?? "").localeCompare(b.airstamp ?? "") || byEpisode(a, b))
  .slice(0, UPCOMING_PER_SHOW);

/** Missing episodes, minus those ignored automatically (before the first one on the server) or by hand. */
function splitGaps(show, gaps, ignored, ignoreEarlier) {
  const first = [...show.counted].sort(byEpisode)[0];
  const isEarlier = (ep) => ignoreEarlier && first && byEpisode(ep, first) < 0;
  return {
    ignoredEarlier: gaps.filter(isEarlier),
    ignoredByHand: gaps.filter((ep) => !isEarlier(ep) && ignored.has(episodeKey(ep))),
    missing: gaps.filter((ep) => !isEarlier(ep) && !ignored.has(episodeKey(ep))),
  };
}

const ANILIST_AIRING = new Set(["RELEASING", "NOT_YET_RELEASED", "HIATUS"]);

/**
 * The same comparison for anime, from AniList: episodes 1 to N of each matched season have
 * aired, where N comes from the next airing episode (or the total once finished). Exact
 * broadcast times come from AniList's schedule. `data` is { media, schedule } from Rust.
 */
export function compareWithAniList(show, data, { now = Date.now(), ignored = new Set(), ignoreEarlier = true } = {}) {
  const media = new Map((data.media ?? []).map((m) => [m.id, m]));
  const gaps = [];
  const upcoming = [];
  const schedule = [];
  let numberingDiffers = false;
  let airing = false;
  for (const [seasonText, id] of Object.entries(show.anilist ?? {})) {
    const season = Number(seasonText);
    const entry = media.get(id);
    if (!entry) return null;
    const next = entry.nextAiringEpisode;
    const aired = ["FINISHED", "CANCELLED"].includes(entry.status)
      ? entry.episodes ?? 0
      : next ? next.episode - 1 : entry.status === "NOT_YET_RELEASED" ? 0 : entry.episodes ?? 0;
    const known = Math.max(entry.episodes ?? 0, next?.episode ?? 0, aired);
    const have = new Set(show.counted.filter((ep) => ep.season === season).map((ep) => ep.number));
    if (known && [...have].some((n) => n > known)) numberingDiffers = true;
    if (ANILIST_AIRING.has(entry.status)) airing = true;

    const times = new Map();
    for (const slot of (data.schedule ?? []).filter((s) => s.mediaId === id)) times.set(slot.episode, slot.airingAt * 1000);
    if (next) times.set(next.episode, next.airingAt * 1000);
    const at = (n) => (times.has(n) ? new Date(times.get(n)).toISOString() : null);

    for (let n = 1; n <= aired; n++) {
      const stamp = times.get(n);
      if (stamp && stamp + MISSING_AFTER_MS > now) continue; // Just aired: still has time to arrive.
      if (!have.has(n)) gaps.push({ season, number: n, name: null, airstamp: at(n), airDate: null });
    }
    for (const [n, stamp] of times) {
      const ep = { season, number: n, name: null, airstamp: at(n), airDate: dayString(new Date(stamp)) };
      schedule.push(ep);
      if (stamp + MISSING_AFTER_MS > now && !have.has(n)) upcoming.push(ep);
    }
  }
  return {
    source: "AniList",
    airing,
    status: airing ? "Airing" : "Ended",
    upcoming: soonest(upcoming),
    ...(numberingDiffers ? { missing: [], ignoredEarlier: [], ignoredByHand: [] } : splitGaps(show, gaps.sort(byEpisode), ignored, ignoreEarlier)),
    numberingDiffers,
    schedule,
  };
}

/** "21:00" in the viewer's time zone and clock style. */
export const airTime = (ep) =>
  ep.airstamp ? new Date(ep.airstamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/** "S1 E4–E6, S2 E1" */
export function episodeRanges(eps) {
  const sorted = [...eps].sort((a, b) => a.season - b.season || a.number - b.number);
  const parts = [];
  for (const ep of sorted) {
    const last = parts.at(-1);
    if (last && last.season === ep.season && last.to === ep.number - 1) last.to = ep.number;
    else parts.push({ season: ep.season, from: ep.number, to: ep.number });
  }
  return parts
    .map((p) => (p.from === p.to ? `S${p.season} E${p.from}` : `S${p.season} E${p.from}–E${p.to}`))
    .join(", ");
}

export function timeAgo(then, now = Date.now()) {
  if (!then) return "Not watched yet";
  const days = Math.floor((now - then) / DAY);
  if (days <= 0) return "Watched today";
  if (days === 1) return "Watched yesterday";
  if (days < 60) return `Watched ${days} days ago`;
  return `Watched ${Math.floor(days / 30)} months ago`;
}

/** "Today", "Tomorrow", or "Friday 14 November" for a YYYY-MM-DD date. */
export function dayLabel(date, today = dayString()) {
  if (date === today) return "Today";
  const [y, m, d] = date.split("-").map(Number);
  const when = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split("-").map(Number);
  const days = Math.round((when - new Date(ty, tm - 1, td)) / DAY);
  if (days === 1) return "Tomorrow";
  const options = { weekday: "long", day: "numeric", month: "long" };
  if (y !== ty) options.year = "numeric";
  return when.toLocaleDateString("en-GB", options);
}
