/* Display registry only. Verified SmartCast identifiers and credentials stay on the controller. */
window.HORIZON_CONFIG = {
  columns: 5,
  searchUrl: "https://horizon-universal-search-preview.ali-al-anbari.workers.dev/?from=home",
  tiles: [
    { id: "horizon-watch", name: "Horizon Watch", artwork: "horizon-watch.svg", kind: "watch", launchState: "supported", favorite: true },
    { id: "prime-video", name: "Prime Video", artwork: "primevideo.svg", launchState: "supported", controllerAppId: "prime-video", favorite: true },
    { id: "youtube", name: "YouTube", artwork: "youtube.svg", launchState: "supported", controllerAppId: "youtube", favorite: true },
    { id: "hulu", name: "Hulu", artwork: "hulu.svg", launchState: "unverified", favorite: true },
    { id: "netflix", name: "Netflix", artwork: "netflix.svg", launchState: "unverified", favorite: true },
    { id: "spotify", name: "Spotify", artwork: "spotify.svg", launchState: "unverified", favorite: false },
    { id: "paramount-plus", name: "Paramount+", artwork: "paramountplus.svg", launchState: "unverified", favorite: false },
    { id: "twitch", name: "Twitch", artwork: "twitch.svg", launchState: "unverified", favorite: false },
    { id: "crunchyroll", name: "Crunchyroll", artwork: "crunchyroll.svg", launchState: "unverified", favorite: false },
    { id: "live-tv", name: "Live TV", artwork: "tv.svg", launchState: "supported", controllerAppId: "live-tv", favorite: false },
    { id: "internet", name: "Browser", artwork: "globe.svg", kind: "browser", launchState: "unavailable", favorite: false },
    { id: "settings", name: "Settings", artwork: "settings.svg", kind: "settings", launchState: "unavailable", favorite: false },
  ],
};
