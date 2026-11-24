(function (root) {
  "use strict";
  var core = root.HorizonSearchCore;
  root.HorizonSearchPlayer = {
    tvUrl: function (id, season, episode, subtitle, title, tvdbId, progress, startOver, handoff, shading) {
      return core.tvPlayerUrl(id, season, episode, subtitle, title, tvdbId, progress, startOver, handoff, shading);
    },
    movieUrl: function (id, title, progress, startOver, handoff, shading) {
      return core.moviePlayerUrl(id, title, progress, startOver, handoff, shading);
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
