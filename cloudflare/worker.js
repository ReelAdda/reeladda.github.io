// FilmyChill edge router — reproduces GitHub Pages URL behaviour exactly.
//
// Runs ONLY when a request matches no file (Cloudflare serves exact file matches like
// /movie/12th-fail.html, /data-in.json or /sitemap.xml directly, free, without this code).
// That leaves three GitHub Pages behaviours to recreate:
//   /hindi/        -> serve hindi/index.html            (200)
//   /hindi         -> redirect to /hindi/               (301, as GitHub Pages does)
//   /movie/foo     -> serve movie/foo.html              (200, GitHub Pages extensionless)
//   anything else  -> branded 404.html                  (404 status)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const asset = (p) => env.ASSETS.fetch(new Request(new URL(p, url), request));

    if (path.endsWith("/")) {
      const res = await asset(path + "index.html");
      if (res.ok || res.status === 304) return res;
      return notFound(env, url);
    }

    const last = path.slice(path.lastIndexOf("/") + 1);
    if (!last.includes(".")) {
      const dir = await asset(path + "/index.html");
      if (dir.ok || dir.status === 304) {
        const to = new URL(url);
        to.pathname = path + "/";
        return Response.redirect(to.toString(), 301);
      }
      const html = await asset(path + ".html");
      if (html.ok || html.status === 304) return html;
    }

    return notFound(env, url);
  },
};

async function notFound(env, url) {
  const page = await env.ASSETS.fetch(new URL("/404.html", url).toString());
  return new Response(page.ok ? page.body : "Not found", {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
