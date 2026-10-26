const SESSION_COOKIE = "__Host-horizon_session";

export function browserWriteAllowed(request, origin, action = "browser") {
  return request.headers.get("origin") === origin
    && request.headers.get("x-horizon-action") === action;
}

export async function pairedBrowserDevice(request, pairing) {
  const part = (request.headers.get("cookie") || "").split(";").map(v => v.trim())
    .find(v => v.startsWith(`${SESSION_COOKIE}=`));
  const value = part?.slice(SESSION_COOKIE.length + 1);
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const hash = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return pairing.authenticate(hash)?.deviceId || null;
}
