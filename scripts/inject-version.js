#!/usr/bin/env node

/**
 * Inject the version from package.json into the built CLI.
 * Replaces __VERSION__ in dist/cli/cli.js with the actual version.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const pkgPath = path.join(repoRoot, "package.json");
const cliPath = path.join(repoRoot, "dist", "cli", "cli.js");

if (!fs.existsSync(pkgPath)) {
  console.error("package.json not found at", pkgPath);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const version = pkg.version ?? "0.0.0";

if (!fs.existsSync(cliPath)) {
  console.error("dist/cli/cli.js not found — run 'npm run build' first");
  process.exit(1);
}

let cliSource = fs.readFileSync(cliPath, "utf-8");

if (cliSource.includes("__VERSION__")) {
  cliSource = cliSource.replace(/"__VERSION__"/g, JSON.stringify(version));
  fs.writeFileSync(cliPath, cliSource, "utf-8");
  console.log(`Injected version ${version} into dist/cli/cli.js`);
} else {
  console.log("No __VERSION__ placeholder found — skipping injection");
}
