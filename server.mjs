import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listDomains, provisionDomain, refreshAllDomains, refreshInstanceDomains, removeDomain, removeInstanceDomains } from "./lib/domains.mjs";
import { DISTRIBUTIONS } from "./lib/distributions.mjs";
import {
  clearSessionCookie, createSessionCookie, resetAdministratorPassword, sessionFromRequest, verifyCredentials,
} from "./lib/auth.mjs";
import {
  createInstance, createInstanceName, createInstanceSnapshot, deleteInstance, deleteInstanceSnapshot,
  getInstanceDetails, listInstances, listOperations, listProfiles, performInstanceAction, reinstallInstance, restoreInstanceSnapshot,
} from "./lib/lxd.mjs";
import { attachTerminalGateway } from "./lib/terminal.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3060);
const HOST = process.env.HOST || "127.0.0.1";
const PROJECT = process.env.LXD_PROJECT || "yourtinyserver-selfhosted";
const APP_ORIGIN = process.env.APP_ORIGIN || `http://${HOST}:${PORT}`;
let activeOperation = null;
let lastOperation = null;
const busyInstances = new Set();
const loginAttempts = new Map();

const STATIC_FILES = new Map([
  ["/", [join(PUBLIC, "index.html"), "text/html; charset=utf-8"]],
  ["/app.js", [join(PUBLIC, "app.js"), "text/javascript; charset=utf-8"]],
  ["/styles.css", [join(PUBLIC, "styles.css"), "text/css; charset=utf-8"]],
  ["/instance.html", [join(PUBLIC, "instance.html"), "text/html; charset=utf-8"]],
  ["/instance.js", [join(PUBLIC, "instance.js"), "text/javascript; charset=utf-8"]],
  ["/terminal.html", [join(PUBLIC, "terminal.html"), "text/html; charset=utf-8"]],
  ["/terminal.js", [join(PUBLIC, "terminal.js"), "text/javascript; charset=utf-8"]],
  ["/auth.js", [join(PUBLIC, "auth.js"), "text/javascript; charset=utf-8"]],
  ["/login.html", [join(PUBLIC, "login.html"), "text/html; charset=utf-8"]],
  ["/login.js", [join(PUBLIC, "login.js"), "text/javascript; charset=utf-8"]],
  ["/vendor/xterm.js", [join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"), "text/javascript; charset=utf-8"]],
  ["/vendor/addon-fit.js", [join(ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"), "text/javascript; charset=utf-8"]],
  ["/vendor/xterm.css", [join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"), "text/css; charset=utf-8"]],
]);

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
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

function clientAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",", 1)[0].trim();
}

function redirectToLogin(response) {
  response.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
  response.end();
}

function operationError(response, error) {
  const message = error instanceof Error ? error.message : "LXD operation failed";
  const status = /not found/i.test(message) ? 404 : /invalid|valid|unsupported|password must/i.test(message) ? 400 : 409;
  return json(response, status, { error: message });
}

async function exclusiveInstance(name, operation) {
  if (busyInstances.has(name)) throw new Error("Another action is already in progress for this instance");
  busyInstances.add(name);
  try { return await operation(); }
  finally { busyInstances.delete(name); }
}

async function staticFile(pathname, response) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [path, contentType] = entry;
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
    if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { ok: true });
    if (request.method === "GET" && ["/login.html", "/login.js", "/styles.css"].includes(url.pathname)) {
      if (await staticFile(url.pathname, response)) return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      const address = clientAddress(request);
      const now = Date.now();
      const attempts = loginAttempts.get(address);
      if (attempts && attempts.resetAt > now && attempts.count >= 5) return json(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
      const input = await body(request);
      if (!await verifyCredentials(String(input.username || ""), String(input.password || ""))) {
        const current = attempts?.resetAt > now ? attempts : { count: 0, resetAt: now + 15 * 60 * 1000 };
        current.count += 1;
        loginAttempts.set(address, current);
        return json(response, 401, { error: "Invalid username or password" });
      }
      loginAttempts.delete(address);
      return json(response, 200, { ok: true }, { "set-cookie": await createSessionCookie(input.username) });
    }

    const session = await sessionFromRequest(request);
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      return session ? json(response, 200, { username: session.username }) : json(response, 401, { error: "Not authenticated" });
    }
    if (!session) {
      if (url.pathname.startsWith("/api/")) return json(response, 401, { error: "Not authenticated" });
      return redirectToLogin(response);
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      return json(response, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/password") {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        const username = await resetAdministratorPassword(input.password);
        return json(response, 200, { ok: true }, { "set-cookie": await createSessionCookie(username) });
      } catch (error) { return operationError(response, error); }
    }

    if (request.method === "GET" && await staticFile(url.pathname, response)) return;

    if (request.method === "GET" && url.pathname === "/api/overview") {
      const [profiles, instances, lxdOperations] = await Promise.all([
        listProfiles(PROJECT),
        listInstances(PROJECT),
        listOperations(PROJECT),
      ]);
      return json(response, 200, {
        project: PROJECT,
        distributions: DISTRIBUTIONS,
        profiles,
        instances,
        activeOperation,
        lastOperation,
        lxdOperations,
      });
    }

    const detail = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})$/);
    if (request.method === "GET" && detail) {
      try {
        const instance = await getInstanceDetails(PROJECT, detail[1]);
        return json(response, 200, { instance, domains: await listDomains(detail[1]), distributions: DISTRIBUTIONS, busy: busyInstances.has(detail[1]) });
      } catch (error) { return operationError(response, error); }
    }

    const actions = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})\/actions$/);
    if (request.method === "POST" && actions) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        if (!["start", "restart", "freeze", "stop"].includes(input.action)) return json(response, 400, { error: "Unsupported instance action" });
        const instance = await exclusiveInstance(actions[1], () => performInstanceAction(PROJECT, actions[1], input.action));
        return json(response, 200, { ok: true, instance });
      } catch (error) { return operationError(response, error); }
    }

    const reinstall = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})\/reinstall$/);
    if (request.method === "POST" && reinstall) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        const instance = await exclusiveInstance(reinstall[1], async () => {
          const result = await reinstallInstance(PROJECT, reinstall[1], input.distribution);
          await refreshInstanceDomains(PROJECT, reinstall[1]);
          return result;
        });
        return json(response, 200, { ok: true, instance });
      } catch (error) { return operationError(response, error); }
    }

    const snapshots = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})\/snapshots$/);
    if (snapshots && ["POST", "PUT", "DELETE"].includes(request.method)) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        const operation = request.method === "POST"
          ? () => createInstanceSnapshot(PROJECT, snapshots[1], input.name)
          : request.method === "PUT"
            ? () => restoreInstanceSnapshot(PROJECT, snapshots[1], input.name)
            : () => deleteInstanceSnapshot(PROJECT, snapshots[1], input.name);
        const result = await exclusiveInstance(snapshots[1], operation);
        return json(response, request.method === "POST" ? 201 : 200, { ok: true, result });
      } catch (error) { return operationError(response, error); }
    }

    const domains = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})\/domains$/);
    if (request.method === "POST" && domains) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        const route = await exclusiveInstance(domains[1], () => provisionDomain(PROJECT, domains[1], input));
        return json(response, 201, { domain: route });
      } catch (error) { return operationError(response, error); }
    }
    if (request.method === "DELETE" && domains) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      try {
        const input = await body(request);
        await exclusiveInstance(domains[1], () => removeDomain(domains[1], input.id));
        return json(response, 200, { ok: true });
      } catch (error) { return operationError(response, error); }
    }

    if (request.method === "POST" && url.pathname === "/api/instances") {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      if (activeOperation) return json(response, 409, { error: `${activeOperation.name} is still ${activeOperation.status}` });
      const lxdOperations = await listOperations(PROJECT);
      if (lxdOperations.length) {
        return json(response, 409, { error: "An LXD operation is already running. Its progress is shown in the instance list." });
      }
      const input = await body(request);
      if (!DISTRIBUTIONS.some((distribution) => distribution.name === input.distribution)) {
        return json(response, 400, { error: "Unsupported Linux distribution" });
      }
      const name = createInstanceName(input.profile);
      const operation = {
        id: `${name}:${Date.now()}`,
        type: "create",
        name,
        profile: input.profile,
        distribution: input.distribution,
        status: "creating",
        startedAt: new Date().toISOString(),
      };
      activeOperation = operation;
      lastOperation = null;
      void createInstance(PROJECT, input.profile, input.distribution, name)
        .then(() => {
          lastOperation = { ...operation, status: "completed", completedAt: new Date().toISOString() };
        })
        .catch((error) => {
          console.error(error);
          lastOperation = {
            ...operation,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "LXD instance creation failed",
          };
        })
        .finally(() => {
          if (activeOperation?.id === operation.id) activeOperation = null;
        });
      return json(response, 202, { name, status: "creating" });
    }

    const deletion = url.pathname.match(/^\/api\/instances\/(yts-[a-z0-9]+-[0-9]{17})$/);
    if (request.method === "DELETE" && deletion) {
      if (!sameOrigin(request)) return json(response, 403, { error: "Invalid request origin" });
      if (busyInstances.has(deletion[1])) return json(response, 409, { error: "Another action is already in progress for this instance" });
      if (activeOperation) return json(response, 409, { error: `${activeOperation.name} is still ${activeOperation.status}` });
      activeOperation = {
        id: `${deletion[1]}:${Date.now()}`,
        type: "delete",
        name: deletion[1],
        status: "deleting",
        startedAt: new Date().toISOString(),
      };
      try {
        await removeInstanceDomains(deletion[1]);
        await deleteInstance(PROJECT, deletion[1]);
        lastOperation = { ...activeOperation, status: "completed", completedAt: new Date().toISOString() };
        return json(response, 200, { ok: true });
      } catch (error) {
        lastOperation = {
          ...activeOperation,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "LXD instance deletion failed",
        };
        throw error;
      } finally {
        activeOperation = null;
      }
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error instanceof Error ? error.message : "Unexpected server error" });
  }
});

attachTerminalGateway(server, { origin: APP_ORIGIN, project: PROJECT, authorize: sessionFromRequest });
server.listen(PORT, HOST, () => {
  console.log(`YourTinyServer Self-Hosted listening on http://${HOST}:${PORT}`);
  void refreshAllDomains(PROJECT).catch((error) => {
    console.error("Unable to refresh domain routes:", error);
  });
});
