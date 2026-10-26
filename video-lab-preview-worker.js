import media from "./video-lab-media-worker.js";
import { playerApi, LaunchQueue, PlayerBridge } from "./video-lab-player-api.js";

export { LaunchQueue, PlayerBridge };

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/api/")) return playerApi(request, env);
    return media.fetch(request, env);
  },
};
