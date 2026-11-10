// Maintenance mode for tankbazaar.com (Netlify EDGE function).
// Lives in netlify/edge-functions/ -- context.next() only exists in Edge Functions,
// so the same code in netlify/functions/ throws and the password is never accepted.
// OFF = the variable MAINTENANCE_PASSWORD is not set in Netlify: the site is served normally.
// ON  = MAINTENANCE_PASSWORD is set: every page asks for a password (browser sign-in box; user name can be anything).
// Turn on / off: Netlify > Site configuration > Environment variables (scope must include Functions), then redeploy.
export default async (request, context) => {
  const password = (Netlify.env.get("MAINTENANCE_PASSWORD") || "").trim();
  if (!password) return; // returning nothing passes the request through unchanged

  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    let given = "";
    try {
      const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      given = decoded.slice(decoded.indexOf(":") + 1);
    } catch (e) { given = ""; }
    if (given.length === password.length) {
      let diff = 0;
      for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ password.charCodeAt(i);
      if (diff === 0) {
        const res = await context.next();
        res.headers.set("Cache-Control", "no-store");
        res.headers.set("X-Robots-Tag", "noindex, nofollow");
        return res;
      }
    }
  }
  return new Response("Tank Bazaar is being built out. Enter the password to continue.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Tank Bazaar (maintenance)", charset="UTF-8"',
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
};

export const config = { path: "/*" };
