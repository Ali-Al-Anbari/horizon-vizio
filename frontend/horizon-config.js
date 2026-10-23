/* Display registry only. Verified SmartCast identifiers and credentials stay on the controller. */
window.HORIZON_CONFIG = {
  columns: 6,
  tiles: [
    { id: "youtube", name: "YouTube", artwork: "youtube.svg", launchState: "supported", controllerAppId: "youtube", favorite: true },
    { id: "plex", name: "Plex", artwork: "plex.svg", launchState: "supported", controllerAppId: "plex", favorite: true },
    { id: "prime-video", name: "Prime Video", artwork: "primevideo.svg", launchState: "supported", controllerAppId: "prime-video", favorite: true },
    { id: "live-tv", name: "Live TV", artwork: "tv.svg", launchState: "supported", controllerAppId: "live-tv", favorite: true },
    { id: "disney-plus", name: "Disney+", artwork: "disneyplus.svg", launchState: "supported", controllerAppId: "disney-plus", favorite: true },
    { id: "internet", name: "Internet", artwork: "globe.svg", kind: "browser", launchState: "unavailable", favorite: true },
    { id: "netflix", name: "Netflix", artwork: "netflix.svg", launchState: "unverified", favorite: false },
    { id: "spotify", name: "Spotify", artwork: "spotify.svg", launchState: "unverified", favorite: false },
    { id: "paramount-plus", name: "Paramount+", artwork: "paramountplus.svg", launchState: "unverified", favorite: false },
    { id: "twitch", name: "Twitch", artwork: "twitch.svg", launchState: "unverified", favorite: false },
    { id: "crunchyroll", name: "Crunchyroll", artwork: "crunchyroll.svg", launchState: "unverified", favorite: false },
    { id: "settings", name: "Settings", artwork: "settings.svg", kind: "settings", launchState: "unavailable", favorite: false },
  ],
};
