import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve("out");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if ((await fs.stat(target)).isDirectory())
      target = path.join(target, "index.html");
    const data = await fs.readFile(target);
    res.writeHead(200, {
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      await fs
        .readFile(path.join(root, "404.html"))
        .catch(() => Buffer.from("Page not found.")),
    );
  }
});
server.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
  console.log(`The Gardens: http://127.0.0.1:${process.env.PORT || 3000}`),
);
