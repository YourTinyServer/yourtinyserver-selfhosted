import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const PASSWORD_FILE = process.env.YTS_PASSWORD_FILE || "/etc/nginx/.htpasswd-yourtinyserver";
const COOKIE_NAME = "yts_session";
const SESSION_SECONDS = 12 * 60 * 60;

function htpasswd(args, password) {
  return new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/htpasswd", args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(stdout);
    });
    child.stdin?.end(`${password}\n`);
  });
}

async function passwordFile() {
  return readFile(PASSWORD_FILE, "utf8");
}

export async function administratorUsername() {
  const line = (await passwordFile()).split(/\r?\n/, 1)[0] || "";
  const username = line.split(":", 1)[0];
  if (!username) throw new Error("Administrator account is not configured");
  return username;
}

function signingKey(contents) {
  return createHash("sha256").update(contents).digest();
}

function signature(value, key) {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function cookieValue(request) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name === COOKIE_NAME) return parts.join("=");
  }
  return null;
}

export async function createSessionCookie(username) {
  const contents = await passwordFile();
  const payload = Buffer.from(JSON.stringify({ username, expiresAt: Date.now() + SESSION_SECONDS * 1000 })).toString("base64url");
  const token = `${payload}.${signature(payload, signingKey(contents))}`;
  const secure = String(process.env.APP_ORIGIN || "").startsWith("https:") ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function clearSessionCookie() {
  const secure = String(process.env.APP_ORIGIN || "").startsWith("https:") ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export async function sessionFromRequest(request) {
  try {
    const token = cookieValue(request);
    if (!token) return null;
    const [payload, suppliedSignature] = token.split(".");
    if (!payload || !suppliedSignature) return null;
    const contents = await passwordFile();
    const expectedSignature = signature(payload, signingKey(contents));
    const supplied = Buffer.from(suppliedSignature);
    const expected = Buffer.from(expectedSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!value.username || Number(value.expiresAt) <= Date.now()) return null;
    if (value.username !== await administratorUsername()) return null;
    return { username: value.username };
  } catch {
    return null;
  }
}

export async function verifyCredentials(username, password) {
  if (username !== await administratorUsername() || typeof password !== "string" || password.length > 256) return false;
  try {
    await htpasswd(["-vi", PASSWORD_FILE, username], password);
    return true;
  } catch {
    return false;
  }
}

export function passwordValidationError(password) {
  if (typeof password !== "string" || password.length < 12) return "Password must contain at least 12 characters";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain a special character";
  if (password.length > 128) return "Password must contain at most 128 characters";
  return null;
}

export async function resetAdministratorPassword(password) {
  const error = passwordValidationError(password);
  if (error) throw new Error(error);
  const username = await administratorUsername();
  await htpasswd(["-iB", PASSWORD_FILE, username], password);
  return username;
}
