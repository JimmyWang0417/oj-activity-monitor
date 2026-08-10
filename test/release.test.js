"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

async function loadContract() {
  return import("../scripts/release-contract.mjs");
}

test("release metadata is generated from the package version and stable GitHub URLs", async () => {
  const contract = await loadContract();
  const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const template = fs.readFileSync(path.join(root, "src", "metadata.txt"), "utf8");
  const version = contract.parsePackageVersion(packageSource);
  const rendered = contract.renderMetadata(template, version);
  const directives = contract.parseMetadataDirectives(rendered.trimEnd());

  assert.deepEqual(directives.get("version"), [version]);
  assert.deepEqual(directives.get("updateURL"), [contract.RELEASE_URLS.update]);
  assert.deepEqual(directives.get("downloadURL"), [contract.RELEASE_URLS.download]);
  assert.doesNotMatch(rendered, /\{\{[A-Z0-9_]+\}\}/);
});

test("metadata rendering fails closed when a release token is missing or duplicated", async () => {
  const contract = await loadContract();
  const template = fs.readFileSync(path.join(root, "src", "metadata.txt"), "utf8");

  assert.throws(() => contract.renderMetadata(template.replace("{{UPDATE_URL}}", ""), "1.2.3"), /UPDATE_URL.*exactly once/);
  assert.throws(() => contract.renderMetadata(`${template}\n// {{VERSION}}`, "1.2.3"), /VERSION.*exactly once/);
  assert.throws(() => contract.renderMetadata(template, "1.2"), /SemVer/);
});

test("metadata-only and installable artifacts are identical in identity and version", async () => {
  const contract = await loadContract();
  const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const version = contract.parsePackageVersion(packageSource);
  const userscript = fs.readFileSync(path.join(root, "dist", "oj-monitor.user.js"), "utf8");
  const metadataOnly = fs.readFileSync(path.join(root, "dist", "oj-monitor.meta.js"), "utf8");
  const userscriptMetadata = contract.extractMetadataBlock(userscript);

  assert.equal(metadataOnly, `${userscriptMetadata}\n`);
  contract.assertReleaseMetadata(userscriptMetadata, version);
  assert.equal(contract.verifyReleaseArtifacts({ packageSource, metadataSource: metadataOnly, userscriptSource: userscript }).version, version);
  assert.equal(contract.extractMetadataBlock(metadataOnly), metadataOnly.trimEnd());

  const context = { console };
  vm.runInNewContext(userscript, context, { filename: "oj-monitor.user.js" });
  assert.equal(context.OJMonitor.version, version);
});

test("release verification rejects drift in every version consumer", async () => {
  const contract = await loadContract();
  const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const metadataOnly = fs.readFileSync(path.join(root, "dist", "oj-monitor.meta.js"), "utf8");
  const userscript = fs.readFileSync(path.join(root, "dist", "oj-monitor.user.js"), "utf8");
  const version = contract.parsePackageVersion(packageSource);
  const otherVersion = "9.9.9";
  const packageObject = JSON.parse(packageSource);

  packageObject.version = otherVersion;
  assert.throws(
    () => contract.verifyReleaseArtifacts({ packageSource: JSON.stringify(packageObject), metadataSource: metadataOnly, userscriptSource: userscript }),
    /@version/
  );
  assert.throws(
    () => contract.verifyReleaseArtifacts({
      packageSource,
      metadataSource: metadataOnly.replace(`@version      ${version}`, `@version      ${otherVersion}`),
      userscriptSource: userscript
    }),
    /metadata-only artifact differs/
  );
  assert.throws(
    () => contract.verifyReleaseArtifacts({
      packageSource,
      metadataSource: metadataOnly,
      userscriptSource: userscript.replace(`@version      ${version}`, `@version      ${otherVersion}`)
    }),
    /@version/
  );
  assert.throws(
    () => contract.verifyReleaseArtifacts({
      packageSource,
      metadataSource: metadataOnly,
      userscriptSource: userscript.replace("version: packageMetadata.version", `version: "${otherVersion}"`)
    }),
    /runtime API version/
  );
  assert.throws(
    () => contract.verifyReleaseArtifacts({
      packageSource,
      metadataSource: metadataOnly,
      userscriptSource: userscript.replace(`\"version\":\"${version}\"`, `\"version\":\"${otherVersion}\"`)
    }),
    /bundled package version/
  );
});
