(function (root) {
  "use strict";
  var core = root.HorizonSearchCore;
  root.HorizonSearchPlayer = {
    tvUrl: function (id, season, episode, subtitle, title, tvdbId) {
      return core.tvPlayerUrl(id, season, episode, subtitle, title, tvdbId);
    },
    // The provider documents a movie embed URL, but Video Lab has no verified
    // movie route or movie-specific playback behavior. Keep this unavailable.
    movieUrl: function () { return null; }
  };
})(typeof window !== "undefined" ? window : globalThis);
