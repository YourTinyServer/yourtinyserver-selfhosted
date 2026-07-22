import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROFILE_NAMES = ["Tiny 512", "Tiny 1G", "Tiny 2G", "Tiny 4G", "Tiny 8G"];
const MANAGED_NAME = /^yts-[a-z0-9]+-[0-9]{17}$/;

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
    const result = await execFileAsync("lxc", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const details = error;
    const message = String(details.stderr || details.message || "LXD command failed").trim();
    throw new Error(message.slice(-1500));
  }
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

export async function createInstance(project, profile) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error("Invalid profile");
  const name = createInstanceName(profile);
  await lxc([
    "launch", "ubuntu:24.04", name,
    "--project", project,
    "--profile", profile,
    "--config", "user.yts.managed=true",
  ], 300_000);
  return name;
}

export async function deleteInstance(project, name) {
  if (!isManagedName(name)) throw new Error("Invalid instance name");
  const output = await lxc(["config", "get", name, "user.yts.managed", "--project", project]);
  if (output !== "true") throw new Error("This instance is not managed by this dashboard");
  await lxc(["delete", name, "--force", "--project", project], 180_000);
}

