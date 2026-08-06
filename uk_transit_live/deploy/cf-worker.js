/**
 * UK Transit Live - Cloudflare Worker edge proxy.
 *
 * Deployed at https://go.ukt.workers.dev  (account subdomain "ukt", worker "go")
 *
 * WHY THIS EXISTS
 * O2/giffgaff's network filter kills the TLS handshake to destinations its
 * categorisation engine does not recognise. That includes raw IPs and the free
 * wildcard-DNS names we used before (145.241.199.54.sslip.io / .nip.io), which
 * share a "dynamic DNS / anonymiser" reputation with a lot of malware
 * infrastructure. Symptom: "Safari cannot open the page because it could not
 * establish a secure connection", on mobile data only, while the same URL works
 * on wifi and the server logs show the request never arrived at all.
 *
 * A workers.dev hostname is categorised and clean, so mobile networks let it
 * through. Traffic lands on Cloudflare's edge and is forwarded to the Oracle
 * origin over its sslip.io name, which still has a valid Let's Encrypt cert.
 *
 * TRADE-OFFS
 * - Free plan: 100,000 requests/day, account-wide. This app polls constantly,
 *   so a handful of concurrent viewers is fine but a crowd is not. If that ever
 *   binds, the fix is a real domain pointed straight at the origin - no Worker.
 * - One extra network hop (~50-100ms). Irrelevant next to the app's own polling.
 * - The origin stays reachable directly, so the sslip/nip URLs remain valid
 *   fallbacks on networks that do not filter.
 *
 * The dashboard copy is the one actually serving traffic. If you edit this
 * file, paste it into the Cloudflare dashboard too (Workers & Pages -> go ->
 * Edit code -> Deploy), or the two silently diverge.
 */
const ORIGIN = "https://145.241.199.54.sslip.io";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, ORIGIN);

    const headers = new Headers(request.headers);
    // The origin's certificate is issued for the sslip name, so SNI and Host
    // must match it - otherwise the TLS handshake to the origin fails.
    headers.set("Host", "145.241.199.54.sslip.io");
    // Let the app log the real visitor instead of a Cloudflare edge IP.
    headers.set("X-Forwarded-Proto", "https");
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) headers.set("X-Forwarded-For", ip);

    const resp = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    // Rewrite origin-absolute redirects back to the worker hostname. Without
    // this, Caddy's http->https redirect would bounce a phone to the sslip URL
    // that mobile data cannot load - the exact bug this proxy exists to avoid.
    const out = new Headers(resp.headers);
    const loc = out.get("Location");
    if (loc && loc.startsWith(ORIGIN)) {
      out.set("Location", loc.replace(ORIGIN, url.origin));
    }
    return new Response(resp.body, { status: resp.status, headers: out });
  },
};
