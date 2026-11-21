import worker from "./universal-search-worker.js";
import ownerHtml from "./frontend/owner.html";
import ownerCss from "./frontend/owner.css";
import ownerJs from "./frontend/owner.js";

export { LaunchQueue } from "./cloud/bridge-worker.js";

const html = [ownerHtml, "text/html; charset=utf-8"];
const OWNER_ASSETS = new Map([
  ["/owner", html],
  ["/owner.html", html],
  ["/owner.css", [ownerCss, "text/css; charset=utf-8"]],
  ["/owner.js", [ownerJs, "application/javascript; charset=utf-8"]],
]);

export default {
  fetch(request, env) {
    const ownerAsset = OWNER_ASSETS.get(new URL(request.url).pathname);
    if (ownerAsset && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : ownerAsset[0], { headers: {
        "Content-Type": ownerAsset[1],
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      } });
    }
    return worker.fetch(request, env);
  },
};
