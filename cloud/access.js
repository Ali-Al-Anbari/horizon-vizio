import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksCache = new Map();

export async function verifyOwner(request, env, overrideJwks) {
  if (!env.TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAIL) return false;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return false;
  try {
    let keys = overrideJwks;
    if (!keys) {
      const domain = new URL(env.TEAM_DOMAIN);
      if (domain.protocol !== "https:" || !domain.hostname.endsWith(".cloudflareaccess.com") || domain.pathname !== "/") return false;
      keys = jwksCache.get(domain.origin);
      if (!keys) {
        keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", domain));
        jwksCache.set(domain.origin, keys);
      }
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.TEAM_DOMAIN,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    return typeof payload.email === "string"
      && payload.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
  } catch (_error) {
    return false;
  }
}
