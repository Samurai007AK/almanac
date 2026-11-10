import { missingKeys } from "./env.ts";
import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { MODEL, runTurn } from "./agent.ts";
import { recentTurns } from "./memory.ts";

const PORT = Number(process.env.PORT) || 3000;

const files: Record<string, string> = {
  "/": "public/index.html",
  "/app.js": "public/app.js",
  "/style.css": "public/style.css",
  "/vendor/marked.js": "node_modules/marked/lib/marked.umd.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.min.js",
};
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const json = (res: ServerResponse, body: unknown, status = 200) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && files[url.pathname]) {
    const path = files[url.pathname];
    return res.writeHead(200, { "content-type": `${types[extname(path)]}; charset=utf-8` }).end(await readFile(path));
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, { missing: missingKeys(), model: MODEL, turns: recentTurns(100) });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = String(JSON.parse(body || "{}").text ?? "").trim().slice(0, 4000);
    if (!text) return json(res, { error: "empty message" }, 400);
    if (missingKeys().length) return json(res, { error: `Missing ${missingKeys().join(", ")} in .env` }, 400);

    // Server-sent events over a plain POST response: status lines and tokens reach
    // the browser the moment they exist, which is most of what "fast" feels like.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    await runTurn(text, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    return res.end();
  }

  res.writeHead(404).end("not found");
}).listen(PORT, "127.0.0.1", () => {
  const missing = missingKeys();
  console.log(`\n  Almanac is running at http://localhost:${PORT}  (model: ${MODEL})`);
  if (missing.length) console.log(`  Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.\n`);
});
