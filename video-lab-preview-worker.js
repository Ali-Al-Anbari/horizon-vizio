import media from "./video-lab-media-worker.js";
import { playerApi, pairedSessionAuthorized, LaunchQueue, PlayerBridge } from "./video-lab-player-api.js";
import { subtitleApi } from "./video-lab-subtitles-api.js";

export { LaunchQueue, PlayerBridge };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/subtitles") return subtitleApi(request, env,
      await pairedSessionAuthorized(request, env));
    if (path.startsWith("/api/")) return playerApi(request, env);
    return media.fetch(request, env);
  },
};
