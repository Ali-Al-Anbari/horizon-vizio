(function (root) {
  "use strict";
  var WIDTH = 1280, HEIGHT = 720;
  function mapPoint(clientX, clientY, rect) {
    if (!rect || !isFinite(clientX) || !isFinite(clientY) || !isFinite(rect.width) || !isFinite(rect.height)
        || rect.width <= 0 || rect.height <= 0) return null;
    var scale = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
    var width = WIDTH * scale, height = HEIGHT * scale;
    var left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
    if (clientX < left || clientX >= left + width || clientY < top || clientY >= top + height) return null;
    return { x: Math.min(WIDTH - 1, Math.floor((clientX - left) / scale)),
      y: Math.min(HEIGHT - 1, Math.floor((clientY - top) / scale)) };
  }
  function percentile(values, fraction) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  }
  root.HorizonCloudBrowserCore = { mapPoint: mapPoint, percentile: percentile };
  if (typeof module !== "undefined") module.exports = root.HorizonCloudBrowserCore;
})(typeof window !== "undefined" ? window : globalThis);
