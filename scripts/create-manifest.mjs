import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "SOURCE-MANIFEST.sha256");
const roots = [".gitignore", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "src", "scripts", "test", "dist/oj-monitor.user.js"];

function filesUnder(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => filesUnder(path.join(relative, entry.name)))
    .filter((file) => !file.endsWith("browser-smoke.png"));
}

const files = roots.flatMap(filesUnder).sort();
const lines = files.map((file) => {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
  return `${digest}  ${file.split(path.sep).join("/")}`;
});
const manifest = `${lines.join("\n")}\n`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, manifest);
const candidate = crypto.createHash("sha256").update(manifest).digest("hex");
fs.writeFileSync(path.join(root, "dist", "CANDIDATE.sha256"), `${candidate}  SOURCE-MANIFEST.sha256\n`);
console.log(`Candidate ${candidate} (${files.length} files)`);
