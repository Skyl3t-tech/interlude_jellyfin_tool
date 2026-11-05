import test from "node:test";
import assert from "node:assert/strict";
import { recommend, taste, unstarted } from "../ui/recommend.js";

const series = (Id, Name, Genres, extra = {}) => ({ Id, Name, Genres, UserData: {}, ...extra });
const library = [
  series("f", "Frieren", ["Fantasy", "Adventure", "Drama"]),
  series("d", "Dandadan", ["Action", "Comedy", "Supernatural"], { UserData: { Played: true } }),
  series("a", "Delicious in Dungeon", ["Fantasy", "Adventure", "Comedy"], { CommunityRating: 8.5 }),
  series("b", "Mushoku Tensei", ["Fantasy", "Drama"]),
  series("c", "Chainsaw Man", ["Action", "Supernatural"]),
  series("r", "Romance show", ["Romance"], { CommunityRating: 9.5 }),
  series("p", "Partly watched", ["Fantasy"], { UserData: { PlayedPercentage: 30 } }),
];
const shows = [{ id: "f", title: "Frieren", watched: 30 }];

test("only unstarted shows are recommended", () => {
  const ids = unstarted(library, new Set(["f"])).map((i) => i.Id);
  assert.deepEqual(ids, ["a", "b", "c", "r"]);
});

test("genres are weighted by what you've watched", () => {
  const { weights } = taste(library, shows);
  assert.ok(weights.get("Fantasy") > weights.get("Action")); // Frieren: 30 episodes; Dandadan: 12.
  assert.equal(weights.has("Romance"), false);
});

test("recommendations: best matches first, grouped by your strongest genres", () => {
  const result = recommend(library, shows);
  assert.equal(result.picks[0].item.Id, "a");
  assert.equal(result.picks.some((p) => p.item.Id === "r"), false); // A high rating alone doesn't count.
  assert.equal(result.genres[0].genre, "Fantasy");
  assert.deepEqual(result.genres[0].items.map((c) => c.item.Id), ["a", "b"]);
  assert.match(result.picks[0].reason, /^Because you watch Frieren/);
});
