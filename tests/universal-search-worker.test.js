import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../universal-search-worker.js";

const env = { TMDB_TOKEN: "test-secret-never-returned" };
const req = path => new Request("https://search.example" + path);
const fetcher = value => async (_url, options) => {
  assert.equal(options.headers.Authorization, "Bearer " + env.TMDB_TOKEN);
  return new Response(JSON.stringify(value), { status: 200 });
};

test("combined movie/TV search returns bounded safe metadata and filters people", async () => {
  const value = { results: [
    { media_type: "movie", id: 550, title: "Fight Club", release_date: "1999-10-15", overview: "Movie", poster_path: "/poster.jpg" },
    { media_type: "tv", id: 2190, name: "South Park", first_air_date: "1997-08-13", overview: "TV", popularity: 215.4 },
    { media_type: "person", id: 5, name: "Actor" },
    { media_type: "movie", id: 6, title: "Adult", adult: true },
  ] };
  const response = await api(req("/api/search?q=south&type=all"), env, { fetch: fetcher(value) });
  assert.equal(response.status, 200);
  const rows = (await response.json()).results;
  assert.deepEqual(new Set(rows.map(row => row.type)), new Set(["movie", "tv"]));
  assert.equal(rows.find(row => row.id === 550).poster, "/poster.jpg");
  assert.equal(rows.find(row => row.id === 2190).popularity, 215.4);
  assert.equal(JSON.stringify(rows).includes(env.TMDB_TOKEN), false);
});

test("short partial search widens genuine TMDB candidates, deduplicates, and ranks credible prefixes", async () => {
  const calls = [];
  const fetch = async (url) => {
    const parsed = new URL(url), q = parsed.searchParams.get("query"); calls.push(q);
    const rows = q === "sou" ? [
      { media_type: "movie", id: 1, title: "Sou", popularity: 0.7, vote_count: 0 },
      { media_type: "tv", id: 2, name: "Sour Show", popularity: 30, vote_count: 110 },
      { media_type: "movie", id: 3, title: "Sound Movie", popularity: 30, vote_count: 110 },
    ]
      : q === "sout" ? [
        { media_type: "tv", id: 2190, name: "South Park", popularity: 210, vote_count: 4000 },
        { media_type: "movie", id: 307081, title: "Southpaw", popularity: 75, vote_count: 5200 },
        { media_type: "tv", id: 2190, name: "South Park", popularity: 210, vote_count: 4000 },
      ] : [];
    return new Response(JSON.stringify({ results: rows, total_pages: 1 }));
  };
  const response = await api(req("/api/search?q=sou&type=all"), env, { fetch });
  assert.equal(response.status, 200);
  const rows = (await response.json()).results;
  assert.deepEqual(rows.slice(0, 2).map(row => row.title), ["South Park", "Southpaw"]);
  assert.equal(rows.filter(row => row.id === 2190).length, 1);
  assert.ok(calls.includes("sout"));
  assert.ok(calls.length <= 10);
  const cached = await api(req("/api/search?q=sou&type=all"), env, { fetch });
  assert.deepEqual((await cached.json()).results, rows);
  assert.ok(calls.length <= 10);
});

test("short partial search includes a second TMDB page when available", async () => {
  const calls = [];
  const response = await api(req("/api/search?q=sol&type=tv"), env, { fetch: async url => {
    const parsed = new URL(url), query = parsed.searchParams.get("query");
    const page = Number(parsed.searchParams.get("page"));
    calls.push(`${query}:${page}`);
    return new Response(JSON.stringify({ total_pages: query === "sol" ? 40 : 1,
      results: query === "sol" && page === 2
        ? [{ id: 72, name: "Solar Series", popularity: 80, vote_count: 2000 }] : [] }));
  } });
  assert.equal((await response.json()).results[0].title, "Solar Series");
  assert.ok(calls.includes("sol:2"));
  assert.ok(calls.length <= 10);
});

test("four-letter partial search probes longer prefixes in All, Movies, and TV", async () => {
  for (const type of ["all", "movie", "tv"]) {
    const calls = [];
    const response = await api(req(`/api/search?q=sout&type=${type}`), env, { fetch: async url => {
      const parsed = new URL(url), query = parsed.searchParams.get("query");
      const endpoint = parsed.pathname.split("/").at(-1);
      calls.push([query, endpoint]);
      const rows = query === "sout" ? [
        { id: 1, media_type: "movie", title: "Sout", popularity: 0.5 },
        { id: 2, media_type: "movie", title: "Southern Obscurity", popularity: 30, vote_count: 100 },
        { id: 3, media_type: "tv", name: "Sout News", popularity: 30, vote_count: 100 },
      ] : query === "south" ? [
        { id: 2190, media_type: "tv", name: "South Park", popularity: 210, vote_count: 4000 },
        { id: 307081, media_type: "movie", title: "Southpaw", popularity: 75, vote_count: 5200 },
      ] : [];
      return new Response(JSON.stringify({ results: endpoint === "multi" ? rows
        : rows.filter(row => row.media_type === endpoint), total_pages: 1 }));
    } });
    const rows = (await response.json()).results;
    const wanted = type === "tv" ? [2190] : type === "movie" ? [307081] : [2190, 307081];
    assert.deepEqual(rows.slice(0, wanted.length).map(row => row.id), wanted);
    assert.ok(calls.some(([query]) => query === "south"));
    assert.ok(calls.length <= 10);
    assert.ok(calls.every(([, endpoint]) => endpoint === (type === "all" ? "multi" : type)));
  }
});

test("longer query searches bounded pages and propagates expansion rate limits", async () => {
  const pages = [];
  const paged = await api(req("/api/search?q=south&type=movie"), env, { fetch: async url => {
    const parsed = new URL(url), page = Number(parsed.searchParams.get("page"));
    pages.push(parsed.searchParams.get("query") + ":" + page);
    return new Response(JSON.stringify({ total_pages: 50, results: parsed.searchParams.get("query") === "sout"
      ? [{ id: 307081, title: "Southpaw", popularity: 60, vote_count: 4000 }] : [] }));
  } });
  assert.deepEqual(pages, ["south:1", "south:2", "south:3", "sout:1"]);
  assert.equal((await paged.json()).results[0].title, "Southpaw");
  let calls = 0;
  const limited = await api(req("/api/search?q=sou&type=tv"), env, { fetch: async url => {
    calls++;
    return new URL(url).searchParams.get("query") === "sou"
      ? new Response(JSON.stringify({ results: [] }))
      : new Response("", { status: 429, headers: { "Retry-After": "7" } });
  } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "7");
  assert.ok(calls <= 10);
});

test("type filter uses the correct TMDB operation and rejects arbitrary URLs or bad parameters", async () => {
  let upstream;
  const response = await api(req("/api/search?q=South%20Park&type=tv"), env, {
    fetch: async (url, options) => { upstream = url; return fetcher({ results: [] })(url, options); }
  });
  assert.equal(response.status, 200);
  assert.match(upstream, /\/search\/tv\?query=South%20Park/);
  const short = await api(req("/api/search?q=x&type=all"), env, { fetch: fetcher({ results: [] }) });
  assert.equal(short.status, 200);
  for (const path of ["/api/search?q=", "/api/search?q=movie&type=bad",
    "/api/search?q=movie&url=https%3A%2F%2Fevil.example", "/api/title/tv/0",
    "/api/season/tv/2190/0", "/api/title/movie/12?append_to_response=evil"])
    assert.equal((await api(req(path), env)).status, 400, path);
  assert.equal((await api(new Request("https://search.example/api/search?q=movie", { method: "POST" }), env)).status, 405);
});

test("upstream 429 returns a bounded Retry-After without retrying", async () => {
  let calls = 0;
  const response = await api(req("/api/search?q=test"), env, { fetch: async () => {
    calls += 1; return new Response("", { status: 429, headers: { "Retry-After": "120" } });
  } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(calls, 1);
});

test("details, providers, and seasons preserve categories and exclude unaired episodes", async () => {
  const details = await api(req("/api/title/tv/2190"), env, { fetch: fetcher({ id: 2190, name: "South Park",
    genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }],
    seasons: [{ season_number: 13, episode_count: 14, name: "Season 13" },
      { season_number: 0, episode_count: 3, name: "Specials" }] }) });
  const detailData = await details.json();
  assert.deepEqual(detailData.seasons, [{ number: 13, count: 14, name: "Season 13" }]);
  assert.deepEqual(detailData.genres, ["Animation", "Comedy"]);
  const providers = await api(req("/api/providers/movie/550"), env, { fetch: fetcher({ results: { US: {
    link: "https://www.themoviedb.org/movie/550/watch?locale=US",
    flatrate: [{ provider_id: 9, provider_name: "Amazon Prime Video", logo_path: "/logo.png" }],
    rent: [{ provider_id: 2, provider_name: "Rental" }], buy: [{ provider_id: 3, provider_name: "Purchase" }]
  } } }) });
  const groups = await providers.json();
  assert.equal(groups.stream[0].id, 9);
  assert.equal(groups.rent[0].name, "Rental");
  assert.equal(groups.buy[0].name, "Purchase");
  assert.equal(groups.link, "https://www.themoviedb.org/movie/550/watch?locale=US");
  const unsafe = await api(req("/api/providers/movie/550"), env, { fetch: fetcher({ results: { US: {
    link: "https://evil.example/movie/550/watch?locale=US" } } }) });
  assert.equal((await unsafe.json()).link, null);
  const season = await api(req("/api/season/tv/2190/13"), env, { fetch: fetcher({ season_number: 13,
    episodes: [{ episode_number: 2, name: "The Coon", air_date: "2009-03-18" },
      { episode_number: 3, name: "Future", air_date: "2999-01-01" },
      { episode_number: 0, name: "Special", air_date: "2009-03-18" }] }) });
  assert.deepEqual((await season.json()).episodes.map(row => row.number), [2]);
});

test("TV details carry a validated external TVDB identity for player episode lookup", async () => {
  let upstream;
  const response = await api(req("/api/title/tv/105248"), env, { fetch: async (url, options) => {
    upstream = url;
    return fetcher({ id: 105248, name: "Cyberpunk: Edgerunners",
      external_ids: { tvdb_id: 384541 } })(url, options);
  } });
  assert.match(upstream, /append_to_response=external_ids/);
  assert.equal((await response.json()).tvdbId, 384541);
  const invalid = await api(req("/api/title/tv/105248"), env, {
    fetch: fetcher({ id: 105248, name: "Cyberpunk", external_ids: { tvdb_id: "384541" } }) });
  assert.equal((await invalid.json()).tvdbId, null);
});

test("missing secret and upstream failures return safe, explicit errors", async () => {
  assert.equal((await api(req("/api/search?q=movie"), {})).status, 503);
  const unavailable = await api(req("/api/search?q=movie"), env, { fetch: async () => new Response("", { status: 500 }) });
  assert.deepEqual(await unavailable.json(), { error: "metadata_unavailable" });
  const timeout = await api(req("/api/search?q=movie"), env, { fetch: async () => { throw Error("network"); } });
  assert.deepEqual(await timeout.json(), { error: "metadata_timeout_or_network" });
});
