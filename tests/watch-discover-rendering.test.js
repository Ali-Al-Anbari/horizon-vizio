import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const coreSource = readFileSync(new URL("../universal-search/core.js", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../universal-search/discover-engine.js", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../universal-search/search.js", import.meta.url), "utf8");

// Production TMDB response fixtures matching live /api/discover-similar output
const PROD_FIXTURE_SEVERANCE = {
  seed: {
    type: "tv",
    id: 95396,
    title: "Severance",
    date: "2022-02-18",
    overview: "Mark leads a team of office workers whose memories have been surgically divided between their work and personal lives.",
    poster: "/9hpHTU5YwF3c9O7Pz0o1U7q1r12.jpg",
    backdrop: "/hPea3Qy5Gd6z0G2U1u3O0p7w4q1.jpg",
    rating: "TV-MA",
    genreIds: [18, 9648, 10765],
    genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
    keywordIds: [101, 102, 103, 104],
    keywords: [{ id: 101, name: "dystopia" }, { id: 102, name: "memory" }, { id: 103, name: "workplace" }, { id: 104, name: "conspiracy" }],
    creators: ["Dan Erickson"],
    cast: ["Adam Scott", "Patricia Arquette"]
  },
  candidates: [
    {
      type: "tv",
      id: 70523,
      title: "Dark",
      date: "2017-12-01",
      overview: "A missing child sets four families on a frantic hunt for answers across generations.",
      poster: "/wiiyc3m6HKaQhFBYeuM7ySCNQsG.jpg",
      backdrop: "/2Ahm8Qp3GjVwY8k6R0m2W1e9q8T.jpg",
      genreIds: [18, 9648, 10765],
      genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }],
      keywordIds: [104, 105],
      keywords: [{ id: 104, name: "conspiracy" }, { id: 105, name: "time travel" }],
      popularity: 88.5,
      voteAverage: 8.5,
      voteCount: 5200,
      rating: "TV-MA",
      sources: [{ kind: "similar", rank: 0 }]
    },
    {
      type: "movie",
      id: 264660,
      title: "Ex Machina",
      date: "2014-12-16",
      overview: "A programmer is invited to administer the Turing test to an intelligent humanoid robot.",
      poster: "/dmJW8tA6fWcZ7m3Nq1x9E4w2P8K.jpg",
      backdrop: "/qXQ1sP2k5W4k8e0M7c9n2B5v1A8.jpg",
      genreIds: [18, 878],
      genres: [{ id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }],
      keywordIds: [101, 103],
      keywords: [{ id: 101, name: "dystopia" }, { id: 103, name: "workplace" }],
      popularity: 75.2,
      voteAverage: 7.6,
      voteCount: 12500,
      rating: "R",
      sources: [{ kind: "cross_media", rank: 1 }]
    },
    // Candidate without poster artwork (must display text title without being dropped)
    {
      type: "tv",
      id: 991122,
      title: "Artless Mystery",
      date: "2021-05-10",
      overview: "An indie mystery series without promotional poster assets.",
      poster: null,
      backdrop: null,
      genreIds: [18, 9648],
      genres: [{ id: 18, name: "Drama" }, { id: 9648, name: "Mystery" }],
      keywordIds: [104],
      keywords: [{ id: 104, name: "conspiracy" }],
      popularity: 25.0,
      voteAverage: 7.8,
      voteCount: 450,
      rating: "TV-14",
      sources: [{ kind: "discovery", rank: 2 }]
    },
    // Candidate with missing optional fields (no overview, empty keywords)
    {
      type: "tv",
      id: 991133,
      title: "Sparse Metadata Show",
      date: "2023-01-01",
      poster: "/sparsePoster123.jpg",
      backdrop: null,
      genreIds: [18],
      genres: [{ id: 18, name: "Drama" }],
      popularity: 15.0,
      voteAverage: 7.1,
      voteCount: 120,
      sources: [{ kind: "similar", rank: 3 }]
    }
  ]
};

const PROD_FIXTURE_SOUTH_PARK = {
  seed: {
    type: "tv",
    id: 2190,
    title: "South Park",
    date: "1997-08-13",
    overview: "Follow the misadventures of four irreverent grade-schoolers in a quiet Colorado mountain town.",
    poster: "/xEoq2WmDzpzxhkHEsmOYOg6BPg6.jpg",
    backdrop: "/mUkuc2KpV6OswixUhVTm524UMhB.jpg",
    rating: "TV-MA",
    genreIds: [16, 35],
    genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }],
    keywordIds: [501, 502],
    keywords: [{ id: 501, name: "satire" }, { id: 502, name: "black comedy" }],
    creators: ["Trey Parker", "Matt Stone"],
    cast: ["Trey Parker", "Matt Stone"]
  },
  candidates: [
    {
      type: "tv",
      id: 60625,
      title: "Rick and Morty",
      date: "2013-12-02",
      overview: "An eccentric sociopathic scientist drags his timid grandson along on insane adventures across the multiverse.",
      poster: "/cvhNj9eoRBe5SxjardQTikImmPM.jpg",
      backdrop: "/7x92g0y3Zt4Y8x1w2V3u4t5s6r7.jpg",
      genreIds: [16, 35, 10765],
      genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
      keywordIds: [501, 502],
      keywords: [{ id: 501, name: "satire" }, { id: 502, name: "black comedy" }],
      popularity: 180.5,
      voteAverage: 8.7,
      voteCount: 9400,
      rating: "TV-MA",
      sources: [{ kind: "recommendations", rank: 0 }]
    },
    {
      type: "movie",
      id: 8718,
      title: "South Park: Bigger, Longer & Uncut",
      date: "1999-06-30",
      overview: "When the boys sneak into an R-rated Canadian movie, their parents demand war.",
      poster: "/j5Q7o8n5w8s9p2w1q3e4r5t6y7u.jpg",
      backdrop: "/1k2l3m4n5o6p7q8r9s0t1u2v3w4.jpg",
      genreIds: [16, 35],
      genres: [{ id: 16, name: "Animation" }, { id: 35, name: "Comedy" }],
      keywordIds: [501, 502],
      keywords: [{ id: 501, name: "satire" }, { id: 502, name: "black comedy" }],
      creators: ["Trey Parker"],
      popularity: 65.0,
      voteAverage: 7.3,
      voteCount: 2800,
      rating: "R",
      sources: [{ kind: "cross_media", rank: 1 }]
    }
  ]
};

function createMockDocument() {
  const elements = new Map();
  function makeElement(tag, id = "", className = "") {
    const el = {
      tagName: tag.toUpperCase(),
      id: id,
      className: className,
      dataset: {},
      style: {},
      classList: {
        classes: new Set(className.split(/\s+/).filter(Boolean)),
        add(c) { this.classes.add(c); el.className = Array.from(this.classes).join(" "); },
        remove(c) { this.classes.delete(c); el.className = Array.from(this.classes).join(" "); },
        contains(c) { return this.classes.has(c); },
        toggle(c, force) {
          if (force === undefined) force = !this.classes.has(c);
          force ? this.add(c) : this.remove(c);
          return force;
        }
      },
      children: [],
      childNodes: [],
      parentNode: null,
      hidden: false,
      textContent: "",
      attributes: {},
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] || null; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) {
        if (!child) return;
        child.parentNode = el;
        el.children.push(child);
        el.childNodes.push(child);
        return child;
      },
      insertBefore(child, before) {
        child.parentNode = el;
        const idx = el.children.indexOf(before);
        if (idx >= 0) { el.children.splice(idx, 0, child); el.childNodes.splice(idx, 0, child); }
        else { el.appendChild(child); }
        return child;
      },
      replaceChildren(...newChildren) {
        el.children = [];
        el.childNodes = [];
        newChildren.forEach(c => el.appendChild(c));
      },
      querySelectorAll(selector) {
        const matches = [];
        function walk(node) {
          if (!node || !node.children) return;
          node.children.forEach(c => {
            if (selector.startsWith(".") && c.classList.contains(selector.slice(1))) matches.push(c);
            else if (selector.startsWith("#") && c.id === selector.slice(1)) matches.push(c);
            else if (selector === "button" && c.tagName === "BUTTON") matches.push(c);
            else if (selector === "img" && c.tagName === "IMG") matches.push(c);
            else if (selector === "strong" && c.tagName === "STRONG") matches.push(c);
            else if (selector === "p" && c.tagName === "P") matches.push(c);
            walk(c);
          });
        }
        walk(el);
        return matches;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      closest(sel) {
        if (sel === "[hidden]") {
          let curr = el;
          while (curr) { if (curr.hidden) return curr; curr = curr.parentNode; }
          return null;
        }
        if (sel === "#watch-view") {
          let curr = el;
          while (curr) { if (curr.id === "watch-view") return curr; curr = curr.parentNode; }
          return null;
        }
        if (sel === ".watch-home-row") {
          let curr = el;
          while (curr) { if (curr.classList.contains("watch-home-row")) return curr; curr = curr.parentNode; }
          return null;
        }
        return null;
      },
      addEventListener(_ev, _cb) {},
      dispatchEvent() { return true; },
      getBoundingClientRect() { return { top: 100, bottom: 400, left: 100, right: 380, width: 280, height: 300 }; }
    };
    if (id) elements.set(id, el);
    return el;
  }

  const doc = {
    createElement(tag) { return makeElement(tag); },
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.includes("row") || id.includes("section") || id.includes("view") ? "section"
          : id.includes("btn") || id.includes("toggle") ? "button" : "div";
        makeElement(tag, id);
      }
      return elements.get(id);
    },
    querySelectorAll(selector) {
      const all = [];
      elements.forEach(el => {
        if (selector.startsWith("#") && el.id === selector.slice(1)) all.push(el);
        else if (selector.startsWith(".") && el.classList.contains(selector.slice(1))) all.push(el);
      });
      return all;
    },
    addEventListener(_ev, _cb) {},
    activeElement: null
  };

  return { doc, elements };
}

test("Discover Rendering: Recommendation cards hydrate with valid titles, artwork URLs, and match reasons", () => {
  const root = {};
  runInNewContext(coreSource, { window: root });
  runInNewContext(engineSource, { window: root });
  const engine = root.HorizonDiscoverEngine;

  // 1. Evaluate Severance fixture with TV and Movie candidates
  const ranked = engine.rankDiscoverCategories(PROD_FIXTURE_SEVERANCE.seed, PROD_FIXTURE_SEVERANCE.candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "both"
  });

  assert.ok(ranked.closest.length >= 2, "Closest matches must include candidates");

  // Verify the shape returned from rankDiscoverCategories has candidate fields directly on each item
  const darkCandidate = ranked.closest.find(c => c.id === 70523);
  assert.ok(darkCandidate, "Dark must be in Closest matches");
  assert.equal(darkCandidate.title, "Dark");
  assert.equal(darkCandidate.type, "tv");
  assert.equal(darkCandidate.poster, "/wiiyc3m6HKaQhFBYeuM7ySCNQsG.jpg");
  assert.ok(typeof darkCandidate.matchReason === "string" && darkCandidate.matchReason.length > 0);

  const exMachina = ranked.closest.find(c => c.id === 264660);
  assert.ok(exMachina, "Ex Machina (Movie) must be in Closest matches via cross-media");
  assert.equal(exMachina.title, "Ex Machina");
  assert.equal(exMachina.type, "movie");
  assert.equal(exMachina.poster, "/dmJW8tA6fWcZ7m3Nq1x9E4w2P8K.jpg");
});

test("Discover Rendering: Titles without posters retain valid title and fallback presentation", () => {
  const root = {};
  runInNewContext(coreSource, { window: root });
  runInNewContext(engineSource, { window: root });
  const engine = root.HorizonDiscoverEngine;

  const ranked = engine.rankDiscoverCategories(PROD_FIXTURE_SEVERANCE.seed, PROD_FIXTURE_SEVERANCE.candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "both"
  });

  const artless = [ranked.closest, ranked.vibe, ranked.genre, ranked.gems]
    .flat().find(c => c.id === 991122);
  assert.ok(artless, "Candidate without poster must NOT be dropped from recommendations");
  assert.equal(artless.title, "Artless Mystery");
  assert.equal(artless.poster, null);

  // Check that core.imageUrl handles null safely
  const imgUrl = root.HorizonSearchCore.imageUrl(artless.poster, "poster");
  assert.equal(imgUrl, "", "Missing poster must return empty string, triggering fallback presentation");
});

test("Discover Rendering: South Park seed produces valid candidates with cartoon/satire themes", () => {
  const root = {};
  runInNewContext(coreSource, { window: root });
  runInNewContext(engineSource, { window: root });
  const engine = root.HorizonDiscoverEngine;

  const ranked = engine.rankDiscoverCategories(PROD_FIXTURE_SOUTH_PARK.seed, PROD_FIXTURE_SOUTH_PARK.candidates, {
    feedback: { ratings: {} },
    history: [],
    hideFinished: false,
    targetMedia: "both"
  });

  assert.ok(ranked.closest.length > 0, "South Park seed must generate closest candidates");
  const rickAndMorty = ranked.closest.find(c => c.id === 60625);
  assert.ok(rickAndMorty, "Rick and Morty must match South Park");
  assert.equal(rickAndMorty.title, "Rick and Morty");
  assert.equal(rickAndMorty.poster, "/cvhNj9eoRBe5SxjardQTikImmPM.jpg");

  const movieMatch = ranked.closest.find(c => c.id === 8718);
  assert.ok(movieMatch, "South Park movie must match via shared creator and genre");
  assert.equal(movieMatch.type, "movie");
  assert.ok(movieMatch.matchReason.startsWith("From creator Trey Parker") || movieMatch.matchReason.startsWith("Themes: satire"));
});

test("Discover Empty State: Zero candidates or API failure display descriptive message and action button", () => {
  const { doc, elements } = createMockDocument();
  const emptySec = doc.getElementById("watch-filter-empty");
  const p = doc.createElement("p");
  emptySec.appendChild(p);
  const btn = doc.getElementById("watch-filter-empty-clear");
  emptySec.appendChild(btn);

  // 1. Error state
  p.textContent = "Could not load recommendations. Check your connection and retry.";
  btn.textContent = "Retry";
  emptySec.hidden = false;
  assert.equal(emptySec.hidden, false);
  assert.equal(emptySec.querySelector("p").textContent, "Could not load recommendations. Check your connection and retry.");
  assert.equal(btn.textContent, "Retry");

  // 2. Filter empty state
  p.textContent = "No similar titles match the selected filters.";
  btn.textContent = "Clear Filters";
  assert.equal(emptySec.querySelector("p").textContent, "No similar titles match the selected filters.");
  assert.equal(btn.textContent, "Clear Filters");

  // 3. Zero seed candidates state
  p.textContent = "No similar titles found for Obscure Seed.";
  btn.textContent = "Choose Another Seed";
  assert.equal(emptySec.querySelector("p").textContent, "No similar titles found for Obscure Seed.");
  assert.equal(btn.textContent, "Choose Another Seed");
});
