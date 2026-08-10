import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(root, "scripts", "build.mjs");
const artifacts = ["dist/oj-monitor.meta.js", "dist/oj-monitor.user.js"];

function artifactHashes() {
  return Object.fromEntries(artifacts.map((relative) => {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
    return [relative, digest];
  }));
}

function runBuild() {
  const result = spawnSync(process.execPath, [buildScript], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}

runBuild();
const first = artifactHashes();
runBuild();
const second = artifactHashes();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  console.error("Reproducible build verification failed", { first, second });
  process.exit(1);
}
console.log(`Verified reproducible build: ${artifacts.map((file) => `${file}=${second[file]}`).join(", ")}`);
