import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathSafe } from "../../dist/server/dashboard.js";

describe("isPathSafe (M-7 realpath containment)", () => {
  it("allows paths inside the base", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-path-safe-"));
    const base = path.join(root, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "a.txt"), "x");
    try {
      assert.equal(await isPathSafe(base, path.join(base, "a.txt")), true);
      // Nested path that doesn't exist yet → lexical fallback still allows.
      assert.equal(await isPathSafe(base, path.join(base, "sub", "nested.txt")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the base", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-path-safe-"));
    const base = path.join(root, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "other", "x.txt"), "secret");
    try {
      assert.equal(await isPathSafe(base, path.join(root, "other", "x.txt")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the base (TOCTOU)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-path-safe-"));
    const base = path.join(root, "base");
    fs.mkdirSync(base, { recursive: true });
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "secret");
    const link = path.join(base, "escape.txt");
    fs.symlinkSync(outside, link);
    try {
      // The lexical path looks inside the base, but realpath reveals the escape.
      assert.equal(await isPathSafe(base, link), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to lexical containment when the requested path does not exist yet (ENOENT)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-path-safe-"));
    const base = path.join(root, "base");
    fs.mkdirSync(base, { recursive: true });
    try {
      // A not-yet-created artifact inside the base is accepted at check time.
      assert.equal(await isPathSafe(base, path.join(base, "future", "x.txt")), true);
      // A not-yet-created path outside is still rejected lexically.
      assert.equal(await isPathSafe(base, path.join(root, "other", "x.txt")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
