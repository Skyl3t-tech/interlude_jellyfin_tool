import test from "node:test";
import assert from "node:assert/strict";
import { buildShow, loadShows, timeAgo, minutesLeft } from "../ui/model.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ep = (id, season, number, data = {}, extra = {}) => ({
  Id: id, Type: "Episode", Name: id, SeriesId: "s", SeriesName: "Show",
  ParentIndexNumber: season, IndexNumber: number, UserData: data, ...extra,
});

test("specials do not count toward progress", () => {
  const show = buildShow("s", "Show", null, null,
    [ep("sp", 0, 1, { Played: true }), ep("a", 1, 1, { Played: true }), ep("b", 1, 2)], {}, NOW);
  assert.equal(show.total, 2);
  assert.equal(show.watched, 1);
  assert.equal(show.remaining, 1);
});

test("a partly watched episode beats next up", () => {
  const items = [ep("a", 1, 1, { Played: true }), ep("b", 1, 2, { PlayedPercentage: 40 }), ep("c", 1, 3)];
  const show = buildShow("s", "Show", items[2], items[1], items, {}, NOW);
  assert.equal(show.next.id, "b");
  assert.equal(show.resuming, true);
});

test("shows watched over 30 days ago go on hold", () => {
  const at = (d) => new Date(NOW - d * DAY).toISOString();
  const recent = buildShow("s", "Show", null, null, [ep("a", 1, 1, { Played: true, LastPlayedDate: at(29) })], {}, NOW);
  const old = buildShow("s", "Show", null, null, [ep("a", 1, 1, { Played: true, LastPlayedDate: at(31) })], {}, NOW);
  assert.equal(recent.active, true);
  assert.equal(old.active, false);
});

test("loadShows merges both lists per series, newest first", async () => {
  const at = (d) => new Date(NOW - d * DAY).toISOString();
  const data = {
    "/Shows/NextUp": { Items: [ep("x2", 1, 2, {}, { SeriesId: "x", SeriesName: "X" }), ep("y2", 1, 2, {}, { SeriesId: "y", SeriesName: "Y" })] },
    "/UserItems/Resume": { Items: [ep("y3", 1, 3, { PlayedPercentage: 10 }, { SeriesId: "y", SeriesName: "Y" })] },
    "/Shows/x/Episodes": { Items: [ep("x1", 1, 1, { Played: true, LastPlayedDate: at(5) }), ep("x2", 1, 2)] },
    "/Shows/y/Episodes": { Items: [ep("y1", 1, 1, { Played: true, LastPlayedDate: at(1) }), ep("y2", 1, 2), ep("y3", 1, 3, { PlayedPercentage: 10 })] },
  };
  data["/Items"] = { Items: [] };
  const shows = await loadShows(async (path) => data[path], "u", NOW);
  assert.deepEqual(shows.map((s) => s.id), ["y", "x"]);
  assert.equal(shows[0].next.id, "y3");
  assert.equal(shows[1].next.id, "x2");
});

test("labels", () => {
  assert.equal(timeAgo(NOW - DAY * 3, NOW), "Watched 3 days ago");
  assert.equal(minutesLeft({ runtimeTicks: 14_400_000_000, positionTicks: 6_480_000_000 }), 13);
});

import { compareWithTmdb, episodeRanges, dayLabel, hasAired } from "../ui/model.js";

const noonOn = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, 12).getTime(); };

const jf = (pairs) => buildShow("s", "Show", null, null,
  pairs.map(([s, e], i) => ep(`j${i}`, s, e, { Played: true })), {}, NOW);
const tm = (list, status = "Returning Series", next = null) => ({
  status, next, episodes: list.map(([season, number, airDate]) => ({ season, number, airDate, name: "x" })),
});

test("missing lists aired episodes that Jellyfin lacks", () => {
  const show = jf([[1, 1], [1, 2]]);
  const info = tm([[1, 1, "2026-10-01"], [1, 2, "2026-10-08"], [1, 3, "2026-10-15"], [1, 4, "2026-11-05"], [1, 5, "2026-11-12"]]);
  const result = compareWithTmdb(show, info, { now: noonOn("2026-11-05") });
  assert.deepEqual(result.missing.map((e) => e.number), [3]); // Airing today isn't missing yet.
  assert.deepEqual(result.upcoming.map((e) => e.number), [4, 5]);
  assert.equal(result.airing, true);
});

test("different numbering withholds the missing list", () => {
  const show = jf([[1, 1], [1, 2], [1, 30]]);
  const info = tm([[1, 1, "2020-01-01"], [1, 2, "2020-01-08"], [2, 1, "2020-06-01"]], "Ended");
  const result = compareWithTmdb(show, info, { now: noonOn("2026-11-05") });
  assert.equal(result.numberingDiffers, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.airing, false);
});

test("next episode from TMDB counts even without a season list", () => {
  const show = jf([[1, 1]]);
  const result = compareWithTmdb(show, tm([[1, 1, "2026-01-01"]], "Returning Series", { season: 2, number: 1, airDate: "2027-01-10" }), { now: noonOn("2026-11-05") });
  assert.deepEqual(result.upcoming.map((e) => `${e.season}:${e.number}`), ["2:1"]);
});

test("ranges and day labels", () => {
  const e = (season, number) => ({ season, number });
  assert.equal(episodeRanges([e(1, 5), e(1, 4), e(1, 6), e(2, 1), e(2, 3)]), "S1 E4–E6, S2 E1, S2 E3");
  assert.equal(dayLabel("2026-11-06", "2026-11-05"), "Tomorrow");
  assert.equal(dayLabel("2026-11-14", "2026-11-05"), "Saturday 14 November");
});

test("new episodes are those added after the last watch", () => {
  const at = (d) => new Date(NOW - d * DAY).toISOString();
  const show = buildShow("s", "Show", null, null, [
    ep("a", 1, 1, { Played: true, LastPlayedDate: at(5) }, { DateCreated: at(10) }),
    ep("b", 1, 2, {}, { DateCreated: at(8) }),
    ep("c", 1, 3, {}, { DateCreated: at(1) }),
  ], {}, NOW);
  assert.deepEqual(show.fresh.map((e) => e.id), ["c"]);
});

test("an exact air time decides whether an episode has aired", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  assert.equal(hasAired({ airstamp: "2026-11-05T11:00:00Z", airDate: "2026-11-05" }, now), true);
  assert.equal(hasAired({ airstamp: "2026-11-05T15:00:00Z", airDate: "2026-11-05" }, now), false);
  assert.equal(hasAired({ airDate: "2026-11-04" }, now, "2026-11-05"), true);
  assert.equal(hasAired({ airDate: "2026-11-05" }, now, "2026-11-05"), false);
});

test("episodes before the first one on the server are ignored automatically", () => {
  const show = jf([[2, 1], [2, 2]]);
  const info = tm([[1, 1, "2025-01-01"], [1, 2, "2025-01-08"], [2, 1, "2026-01-01"], [2, 2, "2026-01-08"], [2, 3, "2026-01-15"], [2, 4, "2026-01-22"]]);
  const now = noonOn("2026-11-05");
  const auto = compareWithTmdb(show, info, { now });
  assert.deepEqual(auto.ignoredEarlier.map((e) => `${e.season}:${e.number}`), ["1:1", "1:2"]);
  assert.deepEqual(auto.missing.map((e) => `${e.season}:${e.number}`), ["2:3", "2:4"]);
  const manual = compareWithTmdb(show, info, { now, ignored: new Set(["2:3"]), ignoreEarlier: false });
  assert.deepEqual(manual.missing.map((e) => `${e.season}:${e.number}`), ["1:1", "1:2", "2:4"]);
  assert.deepEqual(manual.ignoredByHand.map((e) => `${e.season}:${e.number}`), ["2:3"]);
});

test("an episode with an exact time gets a day to reach the server", () => {
  const show = jf([[1, 1]]);
  const now = Date.parse("2026-11-05T12:00:00Z");
  const info = { status: "Returning Series", episodes: [
    { season: 1, number: 1, airDate: "2026-10-01" },
    { season: 1, number: 2, airDate: "2026-11-05", airstamp: "2026-11-05T10:00:00Z" },
    { season: 1, number: 3, airDate: "2026-10-29", airstamp: "2026-10-29T10:00:00Z" },
  ] };
  const result = compareWithTmdb(show, info, { now });
  assert.deepEqual(result.missing.map((e) => e.number), [3]);
  assert.deepEqual(result.upcoming.map((e) => e.number), [2]);
});
