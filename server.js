import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleNeonAuthWebhook, readRequestBody } from "./neon-auth-webhook.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 3000);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(root, relativePath));
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    sendJson(res, 403, JSON.stringify({ error: "Forbidden." }));
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, JSON.stringify({ error: "Not found." }));
  }
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/api/neon-auth-webhook") {
    let body;
    try {
      body = await readRequestBody(req);
    } catch {
      sendJson(res, 413, JSON.stringify({ error: "Request body is too large." }));
      return;
    }
    const result = await handleNeonAuthWebhook({ method: req.method, headers: req.headers, body });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  await serveStatic(req, res);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Voices at the Table server listening on ${port}`);
});
