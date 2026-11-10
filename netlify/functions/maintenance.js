// Maintenance mode for tankbazaar.com.
// OFF  = the variable MAINTENANCE_PASSWORD is not set in Netlify: the site is served normally.
// ON   = MAINTENANCE_PASSWORD is set: every page asks for a password (the browser's sign-in box; the user name can be anything).
// Turn on / off: Netlify > Site configuration > Environment variables, then trigger a new deploy.
export default async (request, context) => {
  const password = Netlify.env.get("MAINTENANCE_PASSWORD");
  if (!password) return context.next();

  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
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
    } catch (e) { /* fall through to the challenge */ }
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
