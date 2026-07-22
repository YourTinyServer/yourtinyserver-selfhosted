import assert from "node:assert/strict";
import test from "node:test";
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

