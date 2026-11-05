(function (root) {
  "use strict";
  var core = root.HorizonSearchCore;
  root.HorizonSearchPlayer = {
    tvUrl: function (id, season, episode, subtitle, title, tvdbId, progress, startOver, handoff) {
      return core.tvPlayerUrl(id, season, episode, subtitle, title, tvdbId, progress, startOver, handoff);
    },
    movieUrl: function (id, title, progress, startOver, handoff) {
      return core.moviePlayerUrl(id, title, progress, startOver, handoff);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
