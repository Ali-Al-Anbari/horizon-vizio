(function (root) {
  "use strict";
  var titles = [
    { type: "tv", id: 2190, title: "South Park", date: "1997-08-13", overview: "Four friends navigate life in the small town of South Park.", poster: null, backdrop: null },
    { type: "tv", id: 1396, title: "Breaking Bad", date: "2008-01-20", overview: "A chemistry teacher makes a life-changing choice.", poster: null, backdrop: null },
    { type: "movie", id: 550, title: "Fight Club", date: "1999-10-15", overview: "An insomniac meets a charismatic stranger.", poster: null, backdrop: null }
  ];
  root.HorizonSearchMock = {
    search: function (query, type) { return { results: titles.filter(function (row) {
      return row.title.toLowerCase().indexOf(query.toLowerCase()) >= 0 && (type === "all" || row.type === type);
    }) }; },
    title: function (type, id) { var row = titles.find(function (value) { return value.type === type && value.id === id; });
      return row ? Object.assign({}, row, { seasons: type === "tv" ? [{ number: 13, count: 14, name: "Season 13" },
        { number: 14, count: 14, name: "Season 14" }] : undefined }) : null; },
    providers: function () { return { link: "https://www.themoviedb.org/tv/2190/watch?locale=US",
      stream: [{ id: 9, name: "Amazon Prime Video", logo: null },
      { id: 337, name: "Disney Plus", logo: null }], free: [], rent: [], buy: [], source: "TMDB / JustWatch" }; },
    season: function (id, number) { return { number: number, episodes: number === 13 && id === 2190
      ? [{ number: 1, title: "The Ring", date: "2009-03-11", overview: "", still: null },
        { number: 2, title: "The Coon", date: "2009-03-18", overview: "", still: null },
        { number: 3, title: "Margaritaville", date: "2009-03-25", overview: "", still: null }]
      : [{ number: 1, title: "Episode 1", date: "2010-03-17", overview: "", still: null }] }; }
  };
})(typeof window !== "undefined" ? window : globalThis);
