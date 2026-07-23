import assert from "node:assert/strict";
import test from "node:test";
import { passwordValidationError } from "../lib/auth.mjs";
import { DEFAULT_DISTRIBUTION, DISTRIBUTIONS, distributionByName } from "../lib/distributions.mjs";
import { createInstanceName, isManagedName, PROFILE_NAMES } from "../lib/lxd.mjs";

test("creates predictable managed instance names", () => {
  const name = createInstanceName("Tiny 1G", new Date("2026-07-23T01:02:03.456Z"));
  assert.equal(name, "yts-t1g-20260723010203456");
  assert.equal(isManagedName(name), true);
});

test("rejects unknown profiles and unmanaged names", () => {
  assert.throws(() => createInstanceName("Unlimited"), /Invalid profile/);
  assert.equal(isManagedName("production-database"), false);
  assert.equal(PROFILE_NAMES.length, 5);
});

test("exposes the complete Linux image catalog", () => {
  assert.equal(DISTRIBUTIONS.length, 41);
  assert.equal(DEFAULT_DISTRIBUTION, "Ubuntu 24.04 LTS");
  assert.equal(distributionByName("Debian 13")?.alias, "images:debian/13");
  assert.equal(distributionByName("Windows Server"), null);
});

test("validates administrator password strength", () => {
  assert.match(passwordValidationError("short"), /12 characters/);
  assert.match(passwordValidationError("lowercase-only-password"), /uppercase/);
  assert.equal(passwordValidationError("StrongPassword1!"), null);
});
