(function (root) {
  "use strict";
  var route = root.HorizonEpisodes.parse(root.location.search);
  var url = root.HorizonEpisodes.pageUrl(route.current, route.subtitle,
    route.testEnd && root.location.origin === "https://horizon-video-lab-preview.ali-al-anbari.workers.dev",
    null, route.fromSearch, route.showTitle, route.tvdbId);
  var returnLink = root.document.getElementById("return-player");
  returnLink.href = url;
  returnLink.focus();
  root.document.getElementById("return-episode").textContent = "Return to Season "
    + route.current.season + " · Episode " + route.current.episode;
  root.document.addEventListener("keydown", function (event) {
    if (event.key === "Backspace" || event.key === "Escape" || event.key === "BrowserBack" || event.key === "GoBack") {
      event.preventDefault();
      root.location.replace(url);
    }
  });
})(window);
