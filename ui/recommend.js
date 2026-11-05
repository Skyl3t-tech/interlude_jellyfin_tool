// Recommendations from your own library: shows you haven't started, scored by how
// much their genres overlap with the genres you actually watch.

const PICKS = 8;
const GENRES = 6;
const PER_GENRE = 12;

/** Series you haven't started: not in progress (Next Up or Resume), not played, nothing partly watched. */
export function unstarted(library, trackedIds) {
  return library.filter((item) =>
    !trackedIds.has(item.Id)
    && !item.UserData?.Played
    && !(item.UserData?.PlayedPercentage > 0));
}

/**
 * Genre weights from what you watch: each show counts by the logarithm of the
 * episodes you've seen (fully watched shows count as 12), so one very long show
 * doesn't drown out the rest.
 */
export function taste(library, shows) {
  const genresOf = new Map(library.map((item) => [item.Id, item.Genres ?? []]));
  const seen = new Map(shows.map((show) => [show.id, show.watched]));
  for (const item of library) {
    if (item.UserData?.Played && !seen.has(item.Id)) seen.set(item.Id, 12);
  }
  const weights = new Map();
  const sources = new Map(); // genre -> titles that brought it in
  const titleOf = new Map([...library.map((i) => [i.Id, i.Name]), ...shows.map((s) => [s.id, s.title])]);
  for (const [id, episodes] of seen) {
    if (!episodes) continue;
    for (const genre of genresOf.get(id) ?? []) {
      weights.set(genre, (weights.get(genre) ?? 0) + Math.log2(1 + episodes));
      if (!sources.has(genre)) sources.set(genre, []);
      sources.get(genre).push({ title: titleOf.get(id), weight: Math.log2(1 + episodes) });
    }
  }
  for (const list of sources.values()) list.sort((a, b) => b.weight - a.weight);
  return { weights, sources };
}

/** Score in [0, ~1]: genre match, plus a little for the community rating. No shared genre scores 0. */
export function score(item, { weights }) {
  const genres = item.Genres ?? [];
  if (!genres.length || !weights.size) return 0;
  const top = Math.max(...weights.values());
  const match = genres.reduce((sum, g) => sum + (weights.get(g) ?? 0) / top, 0) / Math.sqrt(genres.length);
  return match > 0 ? match + (item.CommunityRating ?? 0) / 100 : 0;
}

/** "Because you watch Frieren and Dandadan", from the shows behind its strongest genres. */
export function reason(item, { weights, sources }) {
  const genres = [...(item.Genres ?? [])].filter((g) => weights.has(g)).sort((a, b) => weights.get(b) - weights.get(a));
  const titles = [];
  for (const genre of genres) {
    for (const { title } of sources.get(genre) ?? []) {
      if (title && !titles.includes(title)) titles.push(title);
      if (titles.length === 2) break;
    }
    if (titles.length === 2) break;
  }
  if (!titles.length) return "";
  return `Because you watch ${titles.join(" and ")}`;
}

/** Top picks overall, then your strongest genres, each with its best unstarted shows. */
export function recommend(library, shows) {
  const profile = taste(library, shows);
  const candidates = unstarted(library, new Set(shows.map((s) => s.id)))
    .map((item) => ({ item, score: score(item, profile), reason: reason(item, profile) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const genres = [...profile.weights].sort((a, b) => b[1] - a[1]).slice(0, GENRES).map(([g]) => g);
  return {
    picks: candidates.slice(0, PICKS),
    genres: genres
      .map((genre) => ({ genre, items: candidates.filter((c) => c.item.Genres?.includes(genre)).slice(0, PER_GENRE) }))
      .filter((group) => group.items.length),
    hasTaste: profile.weights.size > 0,
  };
}
