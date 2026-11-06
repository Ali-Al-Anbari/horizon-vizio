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
  // Loopback-only recommendation fixtures. These are TMDB identities and artwork, never playback records.
  var recommendationRows = [
    ["movie", 670292, "The Creator", "/3dSivDtOuyxLDxPH4v2tcNG1fP7.jpg", [878,28,12], 11, 4278, 7.0, "movie:157336"],
    ["movie", 559581, "Stowaway", "/eFyRjhJfhNgM565U2mwEp5YUUOv.jpg", [878,18,53], 3, 748, 6.0, "movie:157336"],
    ["movie", 871, "Planet of the Apes", "/2r9iKnlSYEk4daQadsXfcjHfIjQ.jpg", [878,12,18], 10, 4181, 7.7, "movie:157336"],
    ["movie", 13475, "Star Trek", "/lV5OpzAss1z06YNagOVap1I35mH.jpg", [878,28,12], 14, 10846, 7.4, "movie:157336"],
    ["movie", 2103, "Solaris", "/drdrB1hEZmzFlK1xtW5HMxK3LUJ.jpg", [18,878,9648], 4, 1551, 6.0, "movie:157336"],
    ["movie", 299534, "Avengers: Endgame", "/jtDv3lCnST0fZRvdYFwR5CVwK2x.jpg", [12,878,28], 57, 29227, 8.2, "movie:157336"],
    ["movie", 14337, "Primer", "/xEoq2WmDzpzxhkHEsmOYOg6BPg6.jpg", [878,18,53], 5, 2593, 6.7, "movie:157336"],
    ["movie", 687163, "Project Hail Mary", "/iOb2fjXLbpJgyQXe46n1WtGCnaa.jpg", [878,12], 65, 8695, 8.6, "movie:157336"],
    ["tv", 124364, "FROM", "/pRtJagIxpfODzzb0T0NAvZSzErC.jpg", [9648,18,10765], 148, 4406, 8.5, "tv:70523"],
    ["tv", 126, "Unsolved Mysteries", "/1bOXbWqNsRU2ykPiE586I18coLf.jpg", [9648,18,80], 18, 157, 7.7, "tv:70523"],
    ["tv", 91962, "Emergence", "/xqquBr7LURe9CWTbCkMnvXtsilu.jpg", [18,9648,10765], 9, 206, 6.9, "tv:70523"],
    ["tv", 253372, "The Institute", "/7JXZdWifaa6wL0XLRi0GJOlOA8y.jpg", [9648,10765], 16, 212, 7.5, "tv:70523"],
    ["tv", 1920, "Twin Peaks", "/lA9CNSdo50iQPZ8A2fyVpMvJZAf.jpg", [18,9648], 63, 2757, 8.3, "tv:70523"],
    ["tv", 220801, "Fool Me Once", "/Ertv4WLEyHgi8zN4ldOKgPcGAZ.jpg", [18,80,9648], 12, 553, 7.2, "tv:70523"],
    ["tv", 233629, "Bodies", "/qWX71nLvoLsBNPEjddZMC75lq6I.jpg", [80,9648,10765,18], 10, 611, 7.1, "tv:70523"],
    ["tv", 7263, "Wallander", "/xK5jgSqoOfKwNG0WwrFObmIq0YJ.jpg", [18,80,9648], 12, 156, 7.4, "tv:70523"],
    ["movie", 187, "Sin City", "/i66G50wATMmPrvpP95f0XP6ZdVS.jpg", [80,53], 10, 9205, 7.5, "movie:550"],
    ["movie", 641, "Requiem for a Dream", "/9BTwsLaMVHOGFlmsSlx5QYCaXb.jpg", [18], 7, 11459, 8.0, "movie:550"],
    ["movie", 426249, "Lords of Chaos", "/5jDShbwEsILXa2AAmAbOLxyNwyq.jpg", [18,53,10402], 3, 591, 6.8, "movie:550"],
    ["movie", 483906, "Polar", "/qOBEpKVLl8Q9CZScbOcRRVISezV.jpg", [28,80,18], 7, 2639, 6.4, "movie:550"],
    ["tv", 60059, "Better Call Saul", "/fC2HDm5t0kHl7mTm7jxMR31b7by.jpg", [80,18], 86, 7063, 8.7, "tv:1396"],
    ["tv", 80968, "Narcos: Mexico", "/aXwMx8OvRFMfI1RmkbJm6Bq1jVg.jpg", [18,80], 25, 1565, 7.9, "tv:1396"],
    ["tv", 71694, "Snowfall", "/y7ntzl7msiaS6o7dvDbNG7XFYcR.jpg", [18,80], 49, 827, 8.4, "tv:1396"],
    ["tv", 63351, "Narcos", "/rTmal9fDbwh5F0waol2hq35U4ah.jpg", [80,18], 34, 3540, 8.1, "tv:1396"],
    // Real TMDB related-show sample for the loopback South Park long-row preview.
    ["tv", 74204, "Big Mouth", "/1Zio9w1tAd3r5Gu4d9AzTSx2hnT.jpg", [35,16], 38, 1275, 7.6, "tv:2190"],
    ["tv", 5921, "The Life & Times of Tim", "/rbMgK2e5HuOMqHFqBMDMahU7h4S.jpg", [16,35], 11, 43, 7.3, "tv:2190"],
    ["tv", 709, "Robot Chicken", "/x5O2W1JulF0TM16HEITgVNML3KS.jpg", [35,16], 60, 602, 7.6, "tv:2190"],
    ["tv", 93292, "Duncanville", "/fLJ74pNLxYrAMFBNI95VSDPiOGd.jpg", [35,16], 12, 282, 7.7, "tv:2190"],
    ["tv", 1434, "Family Guy", "/3PFsEuAiyLkWsP4GG6dIV37Q6gu.jpg", [16,35], 2137, 5190, 7.4, "tv:2190"],
    ["tv", 539, "Squidbillies", "/ffXx3qq4eopQMof6M26tZ2yiiT3.jpg", [35,16], 23, 89, 6.9, "tv:2190"],
    ["tv", 33922, "Portlandia", "/pfaxCP6YqlFHCL3QytnTanwRTL5.jpg", [35], 24, 186, 6.9, "tv:2190"],
    ["tv", 1433, "American Dad!", "/eb9sH2am9IUSQ8GhXTNAVoujk8W.jpg", [16,35], 185, 2483, 7.0, "tv:2190"],
    ["tv", 97727, "Inside Job", "/qwJUDMJ4i3KBYjeUFK9Js87iJEa.jpg", [35,16], 14, 1038, 8.1, "tv:2190"],
    ["tv", 13943, "Beavis and Butt-Head", "/8BwmD9hMsfUHTAAsVephjJS8pIF.jpg", [16,35], 41, 483, 7.1, "tv:2190"],
    ["tv", 3540, "Kenny vs. Spenny", "/62lyGEvbOMYAQFFEGh1yMjmpTMO.jpg", [35], 12, 66, 7.3, "tv:2190"],
    ["tv", 1542, "Frisky Dingo", "/htOTzAqXEuf5rmqmmcHJG6avqde.jpg", [16,35], 7, 76, 7.4, "tv:2190"],
    ["tv", 32351, "Ugly Americans", "/lGwH9KWYhU16ZYyNX7mz30M0J1U.jpg", [16,35], 9, 686, 8.2, "tv:2190"],
    ["tv", 71737, "A.P. Bio", "/8GwiuZazRFNrmvSkagZlEDH7qSS.jpg", [35], 17, 209, 6.9, "tv:2190"],
    ["tv", 251, "Aqua Teen Hunger Force", "/jCWOkfMLsT2sGHadCkmR65MWtJu.jpg", [16,35], 32, 272, 7.5, "tv:2190"],
    ["movie", 1423191, "Resident Evil", "/gAgWJhUSQWCgtKR8170nMkYlBda.jpg", [27,878,12], 407, 1604, 7.5, null],
    ["movie", 1375441, "Primetime", "/lmrulvLbmaejTix1YaMxo1oGhH1.jpg", [53,18], 117, 316, 6.8, null],
    ["movie", 1381071, "Godzilla Minus Zero", "/hSmIJluOJmTWvJs4d7kHRxjc8s8.jpg", [878,27,28], 87, 35, 8.3, null],
    ["movie", 1283515, "Verity", "/rmaNMA1seHqpjtnYKzyynFAr1g8.jpg", [9648,53], 205, 604, 7.0, null],
    ["tv", 292741, "Nocturne", "/nyvXVcPnHEwVmqCdzjjCsu1jqhm.jpg", [80,18,9648], 99, 34, 7.7, null],
    ["tv", 247718, "MobLand", "/5Xc7WpWsgflfgEMoBlf9TmWhfbH.jpg", [80,18], 322, 1167, 8.6, null]
  ];
  function recommendationCandidates() { return recommendationRows.map(function (value) {
    return { type: value[0], id: value[1], title: value[2], poster: value[3], backdrop: null,
      genreIds: value[4], keywordIds: [], popularity: value[5], voteCount: value[6], voteAverage: value[7],
      sources: [value[8] ? { kind: "recommendation", seed: value[8] } : { kind: "trending" }] };
  }); }
  function recommendations() { return { seeds: [
    { type: "tv", id: 2190, title: "South Park", genreIds: [16,35], keywordIds: [] },
    { type: "movie", id: 157336, title: "Interstellar", genreIds: [12,18,878], keywordIds: [] },
    { type: "tv", id: 70523, title: "Dark", genreIds: [80,18,10765,9648], keywordIds: [] },
    { type: "movie", id: 550, title: "Fight Club", genreIds: [18,53], keywordIds: [] },
    { type: "tv", id: 1396, title: "Breaking Bad", genreIds: [18,80], keywordIds: [] }
  ], avoids: [], candidates: recommendationCandidates() }; }
  function previewHistory(scenario) { return (scenario === "none" ? []
    : scenario === "one-show" ? previewTitles.filter(function (value) { return value[0] === "tv" && value[1] === 70523; })
    : scenario === "south-park" ? previewTitles.filter(function (value) { return value[0] === "tv" && value[1] === 2190; })
      : previewTitles).map(function (value, index) {
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
    recommendations: recommendations,
    title: function (type, id) { var row = titles.find(function (value) { return value.type === type && value.id === id; });
      if (!row) { var preview = previewTitles.find(function (value) { return value[0] === type && value[1] === id; });
        if (preview) row = { type: type, id: id, title: preview[2], poster: preview[3], backdrop: preview[4] }; }
      if (!row) { var recommended = recommendationCandidates().find(function (value) {
        return value.type === type && value.id === id;
      });
        if (recommended) row = recommended; }
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
