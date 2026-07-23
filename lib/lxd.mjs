import { execFile } from "node:child_process";

export const PROFILE_NAMES = ["Tiny 512", "Tiny 1G", "Tiny 2G", "Tiny 4G", "Tiny 8G"];
const MANAGED_NAME = /^yts-[a-z0-9]+-[0-9]{17}$/;
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SNAPSHOT_LIMITS = { "Tiny 512": 1, "Tiny 1G": 1, "Tiny 2G": 2, "Tiny 4G": 3, "Tiny 8G": 5 };
const metricSamples = new Map();

export function isManagedName(value) {
  return MANAGED_NAME.test(String(value || ""));
}

export function createInstanceName(profile, now = new Date()) {
  const code = {
    "Tiny 512": "t512",
    "Tiny 1G": "t1g",
    "Tiny 2G": "t2g",
    "Tiny 4G": "t4g",
    "Tiny 8G": "t8g",
  }[profile];
  if (!code) throw new Error("Invalid profile");
  const timestamp = now.toISOString().replace(/\D/g, "").slice(0, 17);
  return `yts-${code}-${timestamp}`;
}

async function lxc(args, timeout = 120_000) {
  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile("lxc", args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout });
      });
      child.stdin?.end();
    });
    return result.stdout.trim();
  } catch (error) {
    const details = error;
    const message = String(details.stderr || details.message || "LXD command failed").trim();
    throw new Error(message.slice(-1500));
  }
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sizeBytes(value) {
  const match = String(value || "").trim().match(/^([0-9.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?$/i);
  if (!match) return 0;
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  return Math.round(Number(match[1]) * (units[String(match[2] || "B").toLowerCase()] || 1));
}

function profileSummary(profile) {
  const root = profile.devices?.root || {};
  return {
    name: profile.name,
    cpu: profile.config?.["limits.cpu"] || "Shared",
    memory: profile.config?.["limits.memory"] || "Shared",
    disk: root.size || "Pool default",
  };
}

function addresses(instance) {
  const networks = Object.values(instance.state?.network || {});
  const all = networks.flatMap((network) => network.addresses || []);
  return {
    ipv4: all.find((address) => address.family === "inet" && address.scope === "global")?.address || null,
    ipv6: all.find((address) => address.family === "inet6" && address.scope === "global")?.address || null,
  };
}

export async function listProfiles(project) {
  const output = await lxc(["profile", "list", "--project", project, "--format=json"]);
  const profiles = JSON.parse(output || "[]");
  return profiles.filter((profile) => PROFILE_NAMES.includes(profile.name)).map(profileSummary);
}

export async function listInstances(project) {
  const output = await lxc(["list", "--project", project, "--format=json"]);
  const instances = JSON.parse(output || "[]");
  return instances
    .filter((instance) => instance.config?.["user.yts.managed"] === "true")
    .map((instance) => ({
      name: instance.name,
      status: String(instance.status || "unknown").toLowerCase(),
      profile: instance.profiles?.find((profile) => PROFILE_NAMES.includes(profile)) || "Unknown",
      createdAt: instance.created_at || null,
      ...addresses(instance),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function managedInstance(project, name) {
  if (!isManagedName(name)) throw new Error("Invalid instance name");
  const output = await lxc(["list", name, "--project", project, "--format=json"]);
  const instance = JSON.parse(output || "[]").find((candidate) => candidate.name === name);
  if (!instance || instance.config?.["user.yts.managed"] !== "true") throw new Error("Instance not found");
  return instance;
}

async function profileFor(project, instance) {
  const name = instance.profiles?.find((profile) => PROFILE_NAMES.includes(profile)) || "Unknown";
  if (!PROFILE_NAMES.includes(name)) return { name, cpu: "Shared", memory: "Shared", disk: "Pool default" };
  const endpoint = `/1.0/profiles/${encodeURIComponent(name)}?project=${encodeURIComponent(project)}`;
  const output = await lxc(["query", endpoint]);
  return profileSummary(JSON.parse(output || "{}"));
}

async function guestStats(project, name, running) {
  if (!running) return { diskUsedBytes: 0, uptimeSeconds: 0 };
  try {
    const output = await lxc([
      "exec", name, "--project", project, "--", "sh", "-lc",
      "printf '%s ' \"$(cut -d' ' -f1 /proc/uptime)\"; df -B1 --output=used / | tail -1",
    ], 20_000);
    const [uptime, disk] = output.trim().split(/\s+/);
    return { diskUsedBytes: number(disk), uptimeSeconds: Math.floor(number(uptime)) };
  } catch {
    return { diskUsedBytes: 0, uptimeSeconds: 0 };
  }
}

function liveMetrics(name, instance, cpuLimit) {
  const now = Date.now();
  const cpuUsageNs = number(instance.state?.cpu?.usage);
  const networks = Object.entries(instance.state?.network || {}).filter(([network]) => network !== "lo");
  const networkRxBytes = networks.reduce((total, [, value]) => total + number(value.counters?.bytes_received), 0);
  const networkTxBytes = networks.reduce((total, [, value]) => total + number(value.counters?.bytes_sent), 0);
  const previous = metricSamples.get(name);
  const elapsed = previous ? Math.max(0.001, (now - previous.at) / 1000) : 0;
  const cpuPercent = elapsed ? Math.min(100, Math.max(0, (cpuUsageNs - previous.cpuUsageNs) / 1e9 / elapsed / Math.max(1, cpuLimit) * 100)) : 0;
  const networkRxBps = elapsed ? Math.max(0, Math.round((networkRxBytes - previous.networkRxBytes) / elapsed)) : 0;
  const networkTxBps = elapsed ? Math.max(0, Math.round((networkTxBytes - previous.networkTxBytes) / elapsed)) : 0;
  metricSamples.set(name, { at: now, cpuUsageNs, networkRxBytes, networkTxBytes });
  return {
    sampledAt: new Date(now).toISOString(), cpuPercent, cpuUsageNs,
    memoryUsedBytes: number(instance.state?.memory?.usage), memoryTotalBytes: number(instance.state?.memory?.total),
    networkRxBytes, networkTxBytes, networkRxBps, networkTxBps,
    processes: number(instance.state?.processes),
  };
}

export async function listInstanceSnapshots(project, name) {
  await managedInstance(project, name);
  const endpoint = `/1.0/instances/${name}/snapshots?recursion=1&project=${encodeURIComponent(project)}`;
  const output = await lxc(["query", endpoint], 30_000);
  return JSON.parse(output || "[]").map((snapshot) => ({
    name: snapshot.name,
    createdAt: snapshot.created_at || null,
    expiresAt: snapshot.expires_at || null,
    stateful: Boolean(snapshot.stateful),
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getInstanceDetails(project, name) {
  const instance = await managedInstance(project, name);
  const profile = await profileFor(project, instance);
  const status = String(instance.status || "unknown").toLowerCase();
  const running = status === "running";
  const [snapshots, guest] = await Promise.all([
    listInstanceSnapshots(project, name),
    guestStats(project, name, running),
  ]);
  const metrics = liveMetrics(name, instance, number(profile.cpu));
  metrics.diskUsedBytes = guest.diskUsedBytes;
  metrics.diskTotalBytes = sizeBytes(profile.disk);
  metrics.uptimeSeconds = guest.uptimeSeconds;
  if (!metrics.memoryTotalBytes) metrics.memoryTotalBytes = sizeBytes(profile.memory);
  return {
    name, status, profile, createdAt: instance.created_at || null,
    ...addresses(instance), metrics, snapshots,
    snapshotLimit: SNAPSHOT_LIMITS[profile.name] || 1,
  };
}

export async function performInstanceAction(project, name, action) {
  const instance = await managedInstance(project, name);
  const status = String(instance.status || "unknown").toLowerCase();
  const allowed = {
    start: ["stopped", "frozen"], restart: ["running"], freeze: ["running"], stop: ["running", "frozen"],
  };
  if (!allowed[action] || !allowed[action].includes(status)) throw new Error(`Cannot ${action} an instance that is ${status}`);
  if (action === "start") await lxc(["start", name, "--project", project], 60_000);
  if (action === "restart") await lxc(["restart", name, "--project", project, "--timeout", "30", "--force"], 75_000);
  if (action === "freeze") await lxc(["pause", name, "--project", project], 60_000);
  if (action === "stop") await lxc(["stop", name, "--project", project, "--timeout", "30", "--force"], 75_000);
  return getInstanceDetails(project, name);
}

function validSnapshotName(name) {
  if (!SNAPSHOT_NAME.test(String(name || ""))) throw new Error("Invalid snapshot name");
}

export async function createInstanceSnapshot(project, name, snapshotName) {
  validSnapshotName(snapshotName);
  const details = await getInstanceDetails(project, name);
  if (details.snapshots.some((snapshot) => snapshot.name === snapshotName)) throw new Error("A snapshot with this name already exists");
  if (details.snapshots.length >= details.snapshotLimit) throw new Error(`Snapshot limit reached (${details.snapshotLimit})`);
  await lxc(["snapshot", name, snapshotName, "--project", project], 180_000);
  return listInstanceSnapshots(project, name);
}

export async function deleteInstanceSnapshot(project, name, snapshotName) {
  validSnapshotName(snapshotName);
  const snapshots = await listInstanceSnapshots(project, name);
  if (!snapshots.some((snapshot) => snapshot.name === snapshotName)) throw new Error("Snapshot not found");
  await lxc(["delete", `${name}/${snapshotName}`, "--project", project], 180_000);
  return listInstanceSnapshots(project, name);
}

export async function restoreInstanceSnapshot(project, name, snapshotName) {
  validSnapshotName(snapshotName);
  const details = await getInstanceDetails(project, name);
  if (!details.snapshots.some((snapshot) => snapshot.name === snapshotName)) throw new Error("Snapshot not found");
  const restart = details.status === "running" || details.status === "frozen";
  if (restart) await lxc(["stop", name, "--project", project, "--force"], 75_000);
  await lxc(["restore", name, snapshotName, "--project", project], 240_000);
  if (restart) await lxc(["start", name, "--project", project], 120_000);
  if (details.status === "frozen") await lxc(["pause", name, "--project", project], 60_000);
  return getInstanceDetails(project, name);
}

export async function listOperations(project) {
  const output = await lxc(["operation", "list", "--project", project, "--format=json"]);
  const operations = JSON.parse(output || "[]");
  return operations
    .filter((operation) => String(operation.status || "").toLowerCase() === "running")
    .map((operation) => ({
      id: operation.id,
      description: operation.description || "LXD operation",
      status: "running",
      createdAt: operation.created_at || null,
    }));
}

export async function createInstance(project, profile, requestedName) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error("Invalid profile");
  const name = requestedName || createInstanceName(profile);
  if (!isManagedName(name)) throw new Error("Invalid instance name");
  await lxc([
    "launch", "ubuntu:24.04", name,
    "--project", project,
    "--profile", profile,
    "--config", "user.yts.managed=true",
  ], 900_000);
  return name;
}

export async function deleteInstance(project, name) {
  if (!isManagedName(name)) throw new Error("Invalid instance name");
  const output = await lxc(["config", "get", name, "user.yts.managed", "--project", project]);
  if (output !== "true") throw new Error("This instance is not managed by this dashboard");
  await lxc(["delete", name, "--force", "--project", project], 180_000);
}
