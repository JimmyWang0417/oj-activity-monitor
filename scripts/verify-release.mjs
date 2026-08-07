import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasePath = path.join(root, "dist", "oj-monitor.user.js");
const source = fs.readFileSync(releasePath, "utf8");
const required = [
  "// ==UserScript==",
  "// ==/UserScript==",
  "// @license      GPL-3.0-only",
  "// @grant        GM_xmlhttpRequest",
  "// @grant        unsafeWindow",
  "// @grant        GM_getValue",
  "// @grant        GM_setValue",
  "// @connect      kenkoooo.com",
  "// @match        https://qoj.ac/*",
  "// @connect      qoj.ac",
  "version: \"0.2.11\"",
  "x-luogu-type",
  "class SiteSessionBridge",
  "function installPageRealmEndpoint",
  "Object.defineProperty(global, \"OJMonitor\""
];

const missing = required.filter((text) => !source.includes(text));
if (missing.length) {
  console.error(`Release verification failed; missing: ${missing.join(", ")}`);
  process.exit(1);
}
if (/require\((['"])\.\.?\//.test(source)) {
  console.error("Release verification failed; unresolved local require() remains");
  process.exit(1);
}
const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
if (!license.includes("GNU GENERAL PUBLIC LICENSE") || !license.includes("Version 3, 29 June 2007")) {
  console.error("Release verification failed; LICENSE is not the complete GPL v3 text");
  process.exit(1);
}
for (const document of ["README.md", "THIRD_PARTY_NOTICES.md"]) {
  if (!fs.existsSync(path.join(root, document))) {
    console.error(`Release verification failed; missing ${document}`);
    process.exit(1);
  }
}
console.log(`Verified dist/oj-monitor.user.js (${Buffer.byteLength(source)} bytes)`);
