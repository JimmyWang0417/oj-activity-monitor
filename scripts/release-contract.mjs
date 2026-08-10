const VERSION_TOKEN = "{{VERSION}}";
const HOMEPAGE_TOKEN = "{{HOMEPAGE_URL}}";
const SUPPORT_TOKEN = "{{SUPPORT_URL}}";
const UPDATE_TOKEN = "{{UPDATE_URL}}";
const DOWNLOAD_TOKEN = "{{DOWNLOAD_URL}}";

export const RELEASE_URLS = Object.freeze({
  homepage: "https://github.com/JimmyWang0417/oj-activity-monitor",
  support: "https://github.com/JimmyWang0417/oj-activity-monitor/issues",
  update: "https://raw.githubusercontent.com/JimmyWang0417/oj-activity-monitor/main/dist/oj-monitor.meta.js",
  download: "https://raw.githubusercontent.com/JimmyWang0417/oj-activity-monitor/main/dist/oj-monitor.user.js"
});

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parsePackageVersion(packageSource) {
  let parsed;
  try {
    parsed = JSON.parse(packageSource);
  } catch (error) {
    throw new Error(`package.json is not valid JSON: ${error.message}`);
  }
  if (typeof parsed.version !== "string" || !SEMVER_PATTERN.test(parsed.version)) {
    throw new Error(`package.json version must be SemVer: ${String(parsed.version)}`);
  }
  return parsed.version;
}

function replaceExactlyOnce(source, token, value) {
  const first = source.indexOf(token);
  if (first < 0 || source.indexOf(token, first + token.length) >= 0) {
    throw new Error(`metadata template must contain ${token} exactly once`);
  }
  return `${source.slice(0, first)}${value}${source.slice(first + token.length)}`;
}

export function extractMetadataBlock(source) {
  const opening = "// ==UserScript==";
  const closing = "// ==/UserScript==";
  if (!source.startsWith(`${opening}\n`)) throw new Error("userscript metadata must start at byte zero");
  const closingIndex = source.indexOf(closing);
  if (closingIndex < 0) throw new Error("userscript metadata closing marker is missing");
  return source.slice(0, closingIndex + closing.length);
}

export function parseMetadataDirectives(metadata) {
  const directives = new Map();
  for (const line of metadata.split("\n")) {
    const match = line.match(/^\/\/ @([^\s]+)\s+(.+?)\s*$/);
    if (!match) continue;
    const values = directives.get(match[1]) ?? [];
    values.push(match[2]);
    directives.set(match[1], values);
  }
  return directives;
}

function requireSingleDirective(directives, name, expected) {
  const values = directives.get(name) ?? [];
  if (values.length !== 1 || values[0] !== expected) {
    throw new Error(`metadata @${name} must equal ${expected} exactly once`);
  }
}

export function assertReleaseMetadata(metadata, version) {
  const directives = parseMetadataDirectives(metadata);
  requireSingleDirective(directives, "name", "OJ Monitor");
  requireSingleDirective(directives, "namespace", "https://github.com/oj-monitor/userscript");
  requireSingleDirective(directives, "version", version);
  requireSingleDirective(directives, "homepageURL", RELEASE_URLS.homepage);
  requireSingleDirective(directives, "supportURL", RELEASE_URLS.support);
  requireSingleDirective(directives, "updateURL", RELEASE_URLS.update);
  requireSingleDirective(directives, "downloadURL", RELEASE_URLS.download);
}

export function renderMetadata(template, version) {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`release version must be SemVer: ${version}`);
  let rendered = template.trimEnd();
  rendered = replaceExactlyOnce(rendered, VERSION_TOKEN, version);
  rendered = replaceExactlyOnce(rendered, HOMEPAGE_TOKEN, RELEASE_URLS.homepage);
  rendered = replaceExactlyOnce(rendered, SUPPORT_TOKEN, RELEASE_URLS.support);
  rendered = replaceExactlyOnce(rendered, UPDATE_TOKEN, RELEASE_URLS.update);
  rendered = replaceExactlyOnce(rendered, DOWNLOAD_TOKEN, RELEASE_URLS.download);
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) throw new Error("metadata template contains an unresolved token");
  if (extractMetadataBlock(rendered) !== rendered) throw new Error("metadata template must contain only the metadata block");
  assertReleaseMetadata(rendered, version);
  return `${rendered}\n`;
}

export function verifyReleaseArtifacts({ packageSource, metadataSource, userscriptSource }) {
  const version = parsePackageVersion(packageSource);
  const userscriptMetadata = extractMetadataBlock(userscriptSource);
  assertReleaseMetadata(userscriptMetadata, version);
  if (metadataSource !== `${userscriptMetadata}\n`) {
    throw new Error("metadata-only artifact differs from the userscript header");
  }
  if (!userscriptSource.includes(`\"version\":${JSON.stringify(version)}`)) {
    throw new Error("bundled package version differs from package.json");
  }
  if (!userscriptSource.includes("version: packageMetadata.version")) {
    throw new Error("runtime API version is not bound to package metadata");
  }
  return { version, metadata: userscriptMetadata };
}
