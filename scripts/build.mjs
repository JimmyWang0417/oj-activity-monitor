import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const entry = path.join(root, "src", "main.js");
const metadataPath = path.join(root, "src", "metadata.txt");
const outputPath = path.join(root, "dist", "oj-monitor.user.js");
const modules = new Map();

function moduleId(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function resolveLocal(fromFile, request) {
  if (!request.startsWith(".")) {
    throw new Error(`Only local CommonJS imports are supported: ${request} in ${moduleId(fromFile)}`);
  }
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error(`Cannot resolve ${request} from ${moduleId(fromFile)}`);
  return resolved;
}

function visit(file) {
  const id = moduleId(file);
  if (modules.has(id)) return id;
  modules.set(id, "");
  let source = fs.readFileSync(file, "utf8");
  source = source.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (_match, _quote, request) => {
    const dependency = resolveLocal(file, request);
    const dependencyId = visit(dependency);
    return `__require(${JSON.stringify(dependencyId)})`;
  });
  modules.set(id, source);
  return id;
}

const entryId = visit(entry);
const metadata = fs.readFileSync(metadataPath, "utf8").trimEnd();
const moduleBody = [...modules.entries()]
  .map(([id, source]) => `${JSON.stringify(id)}: function(module, exports, __require) {\n${source}\n}`)
  .join(",\n");

const bundle = `${metadata}\n\n(function (global) {\n  "use strict";\n  const __modules = {\n${moduleBody}\n  };\n  const __cache = Object.create(null);\n  function __require(id) {\n    if (__cache[id]) return __cache[id].exports;\n    const factory = __modules[id];\n    if (!factory) throw new Error("Unknown bundled module: " + id);\n    const module = { exports: {} };\n    __cache[id] = module;\n    factory(module, module.exports, __require);\n    return module.exports;\n  }\n  const api = __require(${JSON.stringify(entryId)});\n  Object.defineProperty(global, "OJMonitor", { value: api, configurable: true });\n})(typeof globalThis !== "undefined" ? globalThis : window);\n`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, bundle, "utf8");
console.log(`Built ${path.relative(root, outputPath)} (${Buffer.byteLength(bundle)} bytes, ${modules.size} modules)`);
