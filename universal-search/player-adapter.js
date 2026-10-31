(function (root) {
  "use strict";
  var core = root.HorizonSearchCore;
  root.HorizonSearchPlayer = {
    tvUrl: function (id, season, episode, subtitle, title, tvdbId) {
      return core.tvPlayerUrl(id, season, episode, subtitle, title, tvdbId);
    },
    movieUrl: function (id, title) { return core.moviePlayerUrl(id, title); }
  };
})(typeof window !== "undefined" ? window : globalThis);
