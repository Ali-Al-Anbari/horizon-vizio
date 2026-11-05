(function (root) {
  "use strict";
  var titles = [
    { type: "tv", id: 2190, title: "South Park", date: "1997-08-13", overview: "Four friends navigate life in the small town of South Park.", poster: null, backdrop: null },
    { type: "tv", id: 1396, title: "Breaking Bad", date: "2008-01-20", overview: "A chemistry teacher makes a life-changing choice.", poster: null, backdrop: null },
    { type: "movie", id: 550, title: "Fight Club", date: "1999-10-15", overview: "An insomniac meets a charismatic stranger.", poster: null, backdrop: null }
  ];
  // Preview-only rows. Read by search.js only on loopback with ?mock=1&preview-history=1.
  // These illustrative playback positions never enter localStorage or Home sync.
  var previewTitles = [
    ["tv", 2190, "South Park", "/k7n2EVge7G77eMr3brztRGG1fFU.jpg", "/3UviYOlhn8EgXMBuiT6MnUuo1w9.jpg", 13, 2, 820, 1320, false],
    ["tv", 70523, "Dark", "/wiiyc3m6HKaQhFBYeuM7ySCNQsG.jpg", "/3jDXL4Xvj3AzDOF6UH1xeyHW8MH.jpg", 2, 4, 980, 3600, false],
    ["tv", 1396, "Breaking Bad", "/anFx9aTOOYqgS3v7x3R84Kz67ly.jpg", "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg", 3, 7, 1640, 2700, false],
    ["movie", 157336, "Interstellar", "/yQvGrMoipbRoddT0ZR8tPoR7NfX.jpg", "/8sNiAPPYU14PUepFNeSNGUTiHW.jpg", null, null, 4800, 10140, false],
    ["tv", 66732, "Stranger Things", "/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg", "/9P4IIMYY3HifqeruZq0ZZ9g7YUi.jpg", 4, 5, 600, 4300, false],
    ["tv", 100088, "The Last of Us", "/dmo6TYuuJgaYinXBPjrgG9mB5od.jpg", "/lY2DhbA7Hy44fAKddr06UrXWWaQ.jpg", 1, 6, 2300, 3500, false],
    ["tv", 105248, "Cyberpunk: Edgerunners", "/v3JuB15WybKmxDeT1hWdK3j6eSJ.jpg", "/bknKZO7DWVYKeByuJMnGI46PFZg.jpg", 1, 10, 1440, 1440, true],
    ["movie", 155, "The Dark Knight", "/qJ2tW6WMUDux911r6m7haRef0WH.jpg", "/cfT29Im5VDvjE0RpyKOSdCKZal7.jpg", null, null, 9120, 9120, true],
    ["movie", 438631, "Dune", "/v1tRXZ4JtD2Iv6fjkPvT4GiwslV.jpg", "/jYEW5xZkZk2WTrdbMGAPFuBqbDc.jpg", null, null, 9300, 9300, true],
    ["movie", 872585, "Oppenheimer", "/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg", "/neeNHeXjMF5fXoCJRsOmkNGC7q.jpg", null, null, 10800, 10800, true],
    ["tv", 95396, "Severance", "/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg", "/ixgFmf1X59PUZam2qbAfskx2gQr.jpg", 1, 9, 3300, 3300, true],
    ["tv", 94605, "Arcane", "/87C0wecB8bHb1PsrKBI4kJiEkgV.jpg", "/5cvnxEHT3e39DvT6ARw4GNCFrB0.jpg", 2, 9, 2400, 2400, true]
  ];
  function previewHistory() { return previewTitles.map(function (value, index) {
    var at = Date.now() - index * 60000;
    return { type: value[0], id: value[1], title: value[2], poster: value[3], backdrop: value[4],
      season: value[5], episode: value[6], subtitle: "off", at: at,
      progress: { position: value[7], duration: value[8], updatedAt: at, provider: "vidbolt", completed: value[9] } };
  }); }
  root.HorizonSearchMock = {
    previewHistory: previewHistory,
    search: function (query, type) { return { results: titles.filter(function (row) {
      return row.title.toLowerCase().indexOf(query.toLowerCase()) >= 0 && (type === "all" || row.type === type);
    }) }; },
    title: function (type, id) { var row = titles.find(function (value) { return value.type === type && value.id === id; });
      if (!row) { var preview = previewTitles.find(function (value) { return value[0] === type && value[1] === id; });
        if (preview) row = { type: type, id: id, title: preview[2], poster: preview[3], backdrop: preview[4] }; }
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
