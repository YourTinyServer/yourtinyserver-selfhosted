import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { access, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { getInstanceDetails } from "./lxd.mjs";

const DATA_DIR = process.env.YTS_DATA_DIR || "/var/lib/yourtinyserver-selfhosted";
const STORE = `${DATA_DIR}/domains.json`;
const SITES_AVAILABLE = "/etc/nginx/sites-available";
const SITES_ENABLED = "/etc/nginx/sites-enabled";
const ACME_ROOT = `${DATA_DIR}/acme`;
let queue = Promise.resolve();

function serialized(operation) {
  const run = queue.then(operation, operation);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function command(name, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = execFile(name, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim().slice(-2000)));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

async function readStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const value = JSON.parse(await readFile(STORE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStore(value) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STORE);
}

export function normalizeDomain(value) {
  const input = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!input || input.includes("://") || input.includes("/") || input.startsWith("*.")) {
    throw new Error("Enter a hostname only, without a protocol, path, or wildcard");
  }
  const domain = domainToASCII(input);
  const labels = domain.split(".");
  if (!domain || domain.length > 253 || labels.length < 2 || labels.some((label) => (
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) throw new Error("Enter a valid fully qualified domain name");
  return domain;
}

function routePaths(id) {
  const safe = String(id).replace(/[^a-z0-9-]/g, "");
  if (!safe) throw new Error("Invalid domain route");
  const filename = `yts-selfhosted-domain-${safe}.conf`;
  return { available: `${SITES_AVAILABLE}/${filename}`, enabled: `${SITES_ENABLED}/${filename}` };
}

function certificateName(id) {
  return `yts-selfhosted-${String(id).replace(/[^a-z0-9-]/g, "")}`;
}

function protocolForPort(port) {
  return Number(port) === 443 ? "https" : "http";
}

function proxyLocation(ipv4, port, protocol = "http") {
  const tlsOptions = protocol === "https" ? `
    proxy_ssl_server_name on;
    proxy_ssl_name $host;
    proxy_ssl_verify off;` : "";
  return `  location / {
    proxy_pass ${protocol}://${ipv4}:${port};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_request_buffering off;
    proxy_buffering off;${tlsOptions}
  }`;
}

function acmeLocation(ipv4) {
  return `  location ^~ /.well-known/acme-challenge/ {
    root ${ACME_ROOT};
    default_type text/plain;
    try_files $uri @yts_instance_acme;
  }

  location @yts_instance_acme {
    proxy_pass http://${ipv4}:80;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }`;
}

function httpConfig(domain, ipv4, port, protocol = "http") {
  return `server {
  listen 80;
  listen [::]:80;
  server_name ${domain};
  client_max_body_size 0;

${acmeLocation(ipv4)}

${proxyLocation(ipv4, port, protocol)}
}
`;
}

function tlsConfig(domain, ipv4, port, certName, protocol = "http") {
  return `server {
  listen 80;
  listen [::]:80;
  server_name ${domain};
${acmeLocation(ipv4)}
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${domain};
  client_max_body_size 0;
  ssl_certificate /etc/letsencrypt/live/${certName}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${certName}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

${proxyLocation(ipv4, port, protocol)}
}
`;
}

async function writeRoute(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
}

async function reloadNginx() {
  await command("/usr/sbin/nginx", ["-t"], 30_000);
  await command("/usr/bin/systemctl", ["reload", "nginx"], 30_000);
}

async function certbotPath() {
  for (const candidate of ["/snap/bin/certbot", "/usr/bin/certbot"]) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("Certbot is not installed");
}

async function ensureRuntime() {
  await mkdir(SITES_AVAILABLE, { recursive: true });
  await mkdir(SITES_ENABLED, { recursive: true });
  await mkdir(`${ACME_ROOT}/.well-known/acme-challenge`, { recursive: true });
}

async function assertServerNameAvailable(domain, ownPath) {
  const ownName = ownPath.split("/").pop();
  for (const filename of await readdir(SITES_ENABLED).catch(() => [])) {
    if (filename === ownName) continue;
    const content = await readFile(`${SITES_ENABLED}/${filename}`, "utf8").catch(() => "");
    for (const match of content.matchAll(/\bserver_name\s+([^;]+);/g)) {
      if (match[1]?.split(/\s+/).includes(domain)) throw new Error(`${domain} is already configured on this server`);
    }
  }
}

async function assertDns(domain) {
  const expected = process.env.PUBLIC_IPV4;
  if (isIP(expected) !== 4) throw new Error("The server public IPv4 is not configured");
  const addresses = await resolve4(domain).catch(() => []);
  if (!addresses.includes(expected)) throw new Error(`Create a DNS-only A record for ${domain} pointing to ${expected}`);
}

function assertNotReserved(domain) {
  const dashboard = new URL(process.env.APP_ORIGIN).hostname.toLowerCase();
  if (domain === dashboard) throw new Error(`${domain} is reserved by the dashboard`);
}

export async function listDomains(instanceName) {
  return (await readStore()).filter((route) => route.instanceName === instanceName);
}

export async function refreshInstanceDomains(project, instanceName) {
  return serialized(async () => {
    const routes = (await readStore()).filter((route) => route.instanceName === instanceName && route.status === "active");
    if (!routes.length) return;
    const instance = await getInstanceDetails(project, instanceName);
    if (isIP(instance.ipv4) !== 4) throw new Error("The reinstalled instance has no IPv4 address for its domain routes");
    for (const route of routes) {
      const paths = routePaths(route.id);
      await writeRoute(paths.available, tlsConfig(route.domain, instance.ipv4, route.targetPort, route.certificateName, protocolForPort(route.targetPort)));
    }
    await reloadNginx();
  });
}

export async function refreshAllDomains(project) {
  return serialized(async () => {
    const routes = (await readStore()).filter((route) => route.status === "active");
    if (!routes.length) return;
    const instances = new Map();
    for (const route of routes) {
      let instance = instances.get(route.instanceName);
      if (!instance) {
        instance = await getInstanceDetails(project, route.instanceName);
        instances.set(route.instanceName, instance);
      }
      if (isIP(instance.ipv4) !== 4) continue;
      const paths = routePaths(route.id);
      await writeRoute(paths.available, tlsConfig(route.domain, instance.ipv4, route.targetPort, route.certificateName, protocolForPort(route.targetPort)));
    }
    await reloadNginx();
  });
}

export async function provisionDomain(project, instanceName, input) {
  return serialized(async () => {
    const domain = normalizeDomain(input.domain);
    const targetPort = Number(input.targetPort);
    const targetProtocol = protocolForPort(targetPort);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("Target port must be between 1 and 65535");
    assertNotReserved(domain);
    await assertDns(domain);
    const instance = await getInstanceDetails(project, instanceName);
    if (instance.status !== "running" || isIP(instance.ipv4) !== 4) throw new Error("The instance must be running with an IPv4 address");

    const routes = await readStore();
    if (routes.some((route) => route.domain === domain)) throw new Error("This domain is already configured");
    if (routes.filter((route) => route.instanceName === instanceName).length >= 10) throw new Error("An instance can have at most 10 domains");

    const route = {
      id: randomUUID(), instanceName, domain, targetPort, status: "provisioning",
      certificateName: null, errorMessage: null, createdAt: new Date().toISOString(), activatedAt: null,
    };
    routes.push(route);
    await writeStore(routes);
    const paths = routePaths(route.id);
    const certName = certificateName(route.id);

    try {
      await ensureRuntime();
      await assertServerNameAvailable(domain, paths.enabled);
      await writeRoute(paths.available, httpConfig(domain, instance.ipv4, targetPort, targetProtocol));
      await symlink(paths.available, paths.enabled).catch((error) => { if (error.code !== "EEXIST") throw error; });
      await reloadNginx();
      await command(await certbotPath(), [
        "certonly", "--webroot", "--webroot-path", ACME_ROOT,
        "--domain", domain, "--cert-name", certName,
        "--non-interactive", "--agree-tos", "--email", process.env.TLS_EMAIL,
        "--keep-until-expiring",
      ], 180_000);
      await writeRoute(paths.available, tlsConfig(domain, instance.ipv4, targetPort, certName, targetProtocol));
      await reloadNginx();
      route.status = "active";
      route.certificateName = certName;
      route.activatedAt = new Date().toISOString();
      await writeStore(routes);
      return route;
    } catch (error) {
      await unlink(paths.enabled).catch(() => undefined);
      await unlink(paths.available).catch(() => undefined);
      await reloadNginx().catch(() => undefined);
      route.status = "failed";
      route.errorMessage = error instanceof Error ? error.message : String(error);
      await writeStore(routes);
      throw error;
    }
  });
}

export async function updateDomain(project, instanceName, input) {
  return serialized(async () => {
    const targetPort = Number(input.targetPort);
    const targetProtocol = protocolForPort(targetPort);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error("Target port must be between 1 and 65535");
    const routes = await readStore();
    const route = routes.find((candidate) => candidate.id === input.id && candidate.instanceName === instanceName);
    if (!route || route.status !== "active") throw new Error("Active domain route not found");
    const instance = await getInstanceDetails(project, instanceName);
    if (instance.status !== "running" || isIP(instance.ipv4) !== 4) throw new Error("The instance must be running with an IPv4 address");
    const paths = routePaths(route.id);
    await writeRoute(paths.available, tlsConfig(route.domain, instance.ipv4, targetPort, route.certificateName, targetProtocol));
    await reloadNginx();
    route.targetPort = targetPort;
    delete route.targetProtocol;
    await writeStore(routes);
    return route;
  });
}

export async function removeDomain(instanceName, id) {
  return serialized(async () => {
    const routes = await readStore();
    const route = routes.find((candidate) => candidate.id === id && candidate.instanceName === instanceName);
    if (!route) throw new Error("Domain route not found");
    const paths = routePaths(route.id);
    await unlink(paths.enabled).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(paths.available).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await reloadNginx();
    const certbot = await certbotPath().catch(() => null);
    if (certbot && route.certificateName) {
      await command(certbot, ["delete", "--cert-name", route.certificateName, "--non-interactive"], 60_000).catch(() => undefined);
    }
    await writeStore(routes.filter((candidate) => candidate.id !== route.id));
    return true;
  });
}

export async function removeInstanceDomains(instanceName) {
  for (const route of await listDomains(instanceName)) await removeDomain(instanceName, route.id);
}
