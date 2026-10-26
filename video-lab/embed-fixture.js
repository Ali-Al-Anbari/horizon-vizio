(function () {
  "use strict";
  if (location.search === "?view=b") {
    document.body.className = "view-b";
    document.getElementById("view").textContent = "Fixture B";
    document.getElementById("detail").textContent = "Parent-directed iframe navigation reached view B.";
  }
})();
