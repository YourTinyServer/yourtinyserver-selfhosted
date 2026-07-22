import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstance, deleteInstance, listInstances, listProfiles } from "./lib/lxd.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3060);
const HOST = process.env.HOST || "127.0.0.1";
const PROJECT = process.env.LXD_PROJECT || "yourtinyserver-selfhosted";
const APP_ORIGIN = process.env.APP_ORIGIN || `http://${HOST}:${PORT}`;
let operationActive = false;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function body(request) {
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 64 * 1024) throw new Error("Request is too large");
  }
  return JSON.parse(value || "{}");
}

function sameOrigin(request) {
  return request.headers.origin === APP_ORIGIN;
}

async function staticFile(pathname, response) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [filename, contentType] = entry;
  const path = join(PUBLIC, filename);
  const details = await stat(path);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": details.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  createReadStream(path).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", APP_ORIGIN);
    if (request.method === "GET" && await staticFile(url.pathname, response)) return;

    if (request.method === "GET" && url.pathname === "/api/overview") {
      const [profiles, instances] = await Promise.all([listProfiles(PROJECT), listInstances(PROJECT)]);
      return json(response, 200, { project: PROJECT, image: "Ubuntu 24.04 LTS", profiles, instances });
    }

    if (request.method === "POST" && url.pathname === "/api/instances") {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      if (operationActive) return json(response, 409, { error: "Another LXD operation is running" });
      operationActive = true;
      try {
        const input = await body(request);
        const name = await createInstance(PROJECT, input.profile);
        return json(response, 201, { name });
      } finally {
        operationActive = false;
      }
    }

    const deletion = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})$/);
    if (request.method === "DELETE" && deletion) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      if (operationActive) return json(response, 409, { error: "Another LXD operation is running" });
      operationActive = true;
      try {
        await deleteInstance(PROJECT, deletion[1]);
        return json(response, 200, { ok: true });
      } finally {
        operationActive = false;
      }
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error instanceof Error ? error.message : "Unexpected server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`YourTinyServer Self-Hosted listening on http://${HOST}:${PORT}`);
});
