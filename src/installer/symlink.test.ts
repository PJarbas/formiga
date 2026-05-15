import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ensureCliSymlink,
  isCliSymlinked,
  removeCliSymlink,
} from "../../dist/installer/symlink.js";

describe("symlink", () => {
  let tempHome: string;
  let localBin: string;
  let originalHome: string | undefined;
  let originalBinDir: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalBinDir = process.env.TAMANDUA_BIN_DIR;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-symlink-"));
    localBin = path.join(tempHome, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_BIN_DIR;
    process.env.TAMANDUA_STATE_DIR = tempHome; // points .tamandua to tempHome
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalBinDir) process.env.TAMANDUA_BIN_DIR = originalBinDir;
    else delete process.env.TAMANDUA_BIN_DIR;
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("isCliSymlinked", () => {
    it("returns false when no symlink exists", () => {
      assert.equal(isCliSymlinked(), false);
    });

    it("returns true after ensuring the CLI launcher symlink", () => {
      const linkPath = ensureCliSymlink();
      const target = fs.readlinkSync(linkPath);

      assert.equal(path.basename(target), "tamandua");
      assert.equal(path.basename(path.dirname(target)), "bin");
      assert.equal(isCliSymlinked(), true);
    });
  });

  describe("removeCliSymlink", () => {
    it("does not throw when no symlink exists", () => {
      assert.doesNotThrow(() => removeCliSymlink());
    });

    it("removes an existing symlink", () => {
      const fakeCli = path.join(tempHome, "fake-cli");
      fs.writeFileSync(fakeCli, "#!/usr/bin/env node\n", { mode: 0o755 });
      const linkPath = path.join(localBin, "tamandua");
      fs.symlinkSync(fakeCli, linkPath);

      // Verify symlink exists
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink());

      removeCliSymlink();

      // Verify symlink is gone
      assert.ok(!fs.existsSync(linkPath));
    });
  });
});
