"use strict";

const JUDGES = Object.freeze(["codeforces", "atcoder", "vjudge", "luogu", "qoj"]);
const SOURCE_SCOPES = Object.freeze(["problemset", "gym", "default"]);
const SOURCE_STATUSES = Object.freeze([
  "ok",
  "loading",
  "not-found",
  "login-required",
  "verification-required",
  "permission-denied",
  "rate-limited",
  "schema-changed",
  "source-unavailable",
  "partial",
  "network-error"
]);

const STATUS_PRIORITY = Object.freeze({
  ok: 0,
  loading: 1,
  partial: 2,
  "not-found": 3,
  "login-required": 4,
  "verification-required": 5,
  "permission-denied": 6,
  "rate-limited": 7,
  "schema-changed": 8,
  "source-unavailable": 9,
  "network-error": 10
});

class OJMonitorError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "OJMonitorError";
    this.status = SOURCE_STATUSES.includes(status) ? status : "network-error";
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new OJMonitorError("schema-changed", `${field} must be a finite number`);
  return number;
}

function asNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new OJMonitorError("schema-changed", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function createId(prefix = "id", cryptoObject = globalThis.crypto) {
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return `${prefix}-${cryptoObject.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function normalizeUsername(value) {
  return String(value ?? "").trim();
}

function normalizeScope(judge, scope) {
  if (judge === "codeforces") {
    if (scope !== "problemset" && scope !== "gym") throw new TypeError("Codeforces scope must be problemset or gym");
    return scope;
  }
  return "default";
}

function buildSubmissionKey(submission) {
  return [submission.accountId, submission.judge, submission.scope, submission.submissionId].join(":");
}

function buildDailyStatKey(stat) {
  return [stat.groupId, stat.accountId, stat.judge, stat.scope, stat.date].join(":");
}

function inferAccepted(judge, verdict, accepted) {
  if (accepted === true) return true;
  const text = typeof verdict === "string" ? verdict.trim() : "";
  if (judge === "qoj") {
    if (/^(?:AC|Accepted)(?:!|\s*[✓✔√])?$/i.test(text)) return true;
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return Number(text) === 100;
  }
  if (judge === "luogu") return /^(?:AC|Accepted|recordStatus:12)$/i.test(text);
  return false;
}

function normalizeSubmission(input) {
  if (!isRecord(input)) throw new OJMonitorError("schema-changed", "submission must be an object");
  const judge = asNonEmptyString(input.judge, "judge");
  if (!JUDGES.includes(judge)) throw new OJMonitorError("schema-changed", `unsupported judge: ${judge}`);
  const submittedAt = asFiniteNumber(input.submittedAt, "submittedAt");
  return Object.freeze({
    groupId: asNonEmptyString(input.groupId, "groupId"),
    accountId: asNonEmptyString(input.accountId, "accountId"),
    judge,
    scope: normalizeScope(judge, input.scope),
    username: asNonEmptyString(input.username, "username"),
    submissionId: asNonEmptyString(String(input.submissionId ?? ""), "submissionId"),
    problemKey: asNonEmptyString(input.problemKey, "problemKey"),
    problemName: typeof input.problemName === "string" ? input.problemName : undefined,
    problemUrl: typeof input.problemUrl === "string" ? input.problemUrl : undefined,
    submittedAt,
    verdict: typeof input.verdict === "string" ? input.verdict : "UNKNOWN",
    accepted: inferAccepted(judge, input.verdict, input.accepted),
    raw: input.raw
  });
}

function mergeSubmissions(existing, incoming) {
  const byKey = new Map();
  for (const item of [...existing, ...incoming]) {
    const normalized = normalizeSubmission(item);
    byKey.set(buildSubmissionKey(normalized), normalized);
  }
  return [...byKey.values()].sort((left, right) => left.submittedAt - right.submittedAt || left.submissionId.localeCompare(right.submissionId));
}

function localDateKey(epochMillis) {
  const date = new Date(epochMillis);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function zonedDateKey(epochMillis, timeZone = "local") {
  if (timeZone === "local") return localDateKey(epochMillis);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMillis)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDateKey(dateKey, deltaDays) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function recentDateKeys(days, now = Date.now(), timeZone = "local") {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new RangeError("days must be an integer between 1 and 366");
  const current = zonedDateKey(now, timeZone);
  return Array.from({ length: days }, (_unused, index) => shiftDateKey(current, index - days + 1));
}

function combineStatus(current, next) {
  const left = SOURCE_STATUSES.includes(current) ? current : "ok";
  const right = SOURCE_STATUSES.includes(next) ? next : "ok";
  return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left;
}

function resultIdentity(result) {
  return [result.groupId, result.accountId, result.judge, result.scope].join(":");
}

function aggregateDaily(submissions, results, options = {}) {
  const timeZone = options.timeZone || "local";
  const dateKeys = options.dateKeys || recentDateKeys(options.days || 30, options.now || Date.now(), timeZone);
  const allowedDates = new Set(dateKeys);
  const stats = new Map();
  const solvedSets = new Map();

  for (const result of results) {
    const base = {
      groupId: result.groupId,
      accountId: result.accountId,
      judge: result.judge,
      scope: normalizeScope(result.judge, result.scope),
      submissionCount: 0,
      solvedCount: 0,
      excludedCount: 0,
      status: result.coverage?.complete === false && (!result.status || result.status === "ok") ? "partial" : (result.status || "ok"),
      coverageComplete: result.coverage?.complete !== false,
      updatedAt: Number(result.updatedAt || Date.now())
    };
    for (const date of dateKeys) {
      const stat = { ...base, date };
      const excludedByDate = result.excludedByDate?.[date];
      if (Number.isFinite(excludedByDate)) stat.excludedCount = Number(excludedByDate);
      const key = buildDailyStatKey(stat);
      stats.set(key, stat);
      solvedSets.set(key, new Set());
    }
    if (!result.excludedByDate && dateKeys.length && Number.isFinite(Number(result.excludedCount))) {
      const latestKey = buildDailyStatKey({ ...base, date: dateKeys.at(-1) });
      stats.get(latestKey).excludedCount = Number(result.excludedCount);
    }
  }

  for (const item of mergeSubmissions([], submissions)) {
    const date = zonedDateKey(item.submittedAt, timeZone);
    if (!allowedDates.has(date)) continue;
    const key = buildDailyStatKey({ ...item, date });
    let stat = stats.get(key);
    if (!stat) {
      stat = {
        groupId: item.groupId,
        accountId: item.accountId,
        judge: item.judge,
        scope: item.scope,
        date,
        submissionCount: 0,
        solvedCount: 0,
        excludedCount: 0,
        status: "ok",
        coverageComplete: true,
        updatedAt: Date.now()
      };
      stats.set(key, stat);
      solvedSets.set(key, new Set());
    }
    stat.submissionCount += 1;
    if (item.accepted) solvedSets.get(key).add(item.problemKey);
  }

  for (const [key, solved] of solvedSets) stats.get(key).solvedCount = solved.size;
  return [...stats.values()].sort((left, right) => left.date.localeCompare(right.date) || resultIdentity(left).localeCompare(resultIdentity(right)));
}

function summarizeGroup(stats, groupId, dateKeys) {
  const allowed = new Set(dateKeys);
  const selected = stats.filter((stat) => stat.groupId === groupId && allowed.has(stat.date));
  return selected.reduce((summary, stat) => {
    summary.submissionCount += stat.submissionCount;
    summary.solvedCount += stat.solvedCount;
    summary.excludedCount += stat.excludedCount;
    summary.status = combineStatus(summary.status, stat.status);
    summary.coverageComplete &&= stat.coverageComplete;
    return summary;
  }, { groupId, submissionCount: 0, solvedCount: 0, excludedCount: 0, status: "ok", coverageComplete: true });
}

function parseCodeforcesProblemUrl(url, base = "https://codeforces.com") {
  let parsed;
  try {
    parsed = new URL(url, base);
  } catch {
    return null;
  }
  const patterns = [
    { expression: /^\/gym\/(\d+)\/problem\/([^/?#]+)/i, scope: "gym", path: (id, index) => `/gym/${id}/problem/${index}` },
    { expression: /^\/contest\/(\d+)\/problem\/([^/?#]+)/i, scope: "problemset", path: (id, index) => `/problemset/problem/${id}/${index}` },
    { expression: /^\/problemset\/problem\/(\d+)\/([^/?#]+)/i, scope: "problemset", path: (id, index) => `/problemset/problem/${id}/${index}` }
  ];
  for (const pattern of patterns) {
    const match = parsed.pathname.match(pattern.expression);
    if (!match) continue;
    const contestId = match[1];
    const index = decodeURIComponent(match[2]);
    return {
      scope: pattern.scope,
      contestId,
      index,
      problemKey: `codeforces:${pattern.scope}:${contestId}:${index}`,
      canonicalUrl: new URL(pattern.path(contestId, encodeURIComponent(index)), base).href
    };
  }
  return null;
}

function classifyCodeforcesContest({ contestId, url, gymContestIds, regularContestIds }) {
  if (url) {
    const parsed = parseCodeforcesProblemUrl(url);
    if (parsed) return parsed.scope;
  }
  const numericId = Number(contestId);
  if (!Number.isInteger(numericId)) return "unsupported";
  if (gymContestIds.has(numericId)) return "gym";
  if (regularContestIds.has(numericId)) return "problemset";
  return "unsupported";
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    groups: [],
    settings: {
      days: 30,
      timeZone: "local",
      metric: "solved",
      autoRefreshMinutes: 15,
      theme: "system"
    }
  };
}

function normalizeAccount(account, index = 0) {
  if (!isRecord(account)) throw new TypeError("account must be an object");
  const judge = asNonEmptyString(account.judge, "account.judge");
  if (!JUDGES.includes(judge)) throw new TypeError(`Unknown judge: ${judge}`);
  const normalized = {
    id: normalizeUsername(account.id) || createId("account"),
    judge,
    username: normalizeUsername(account.username),
    enabled: account.enabled !== false,
    sortOrder: Number.isFinite(account.sortOrder) ? Number(account.sortOrder) : index
  };
  if (judge === "codeforces") {
    normalized.scopes = {
      problemset: account.scopes?.problemset !== false,
      gym: account.scopes?.gym !== false
    };
  }
  return normalized;
}

function normalizeConfig(config) {
  const defaults = defaultConfig();
  if (!isRecord(config)) return defaults;
  const groups = Array.isArray(config.groups) ? config.groups.map((group, groupIndex) => ({
    id: normalizeUsername(group?.id) || createId("group"),
    name: normalizeUsername(group?.name) || `监测对象 ${groupIndex + 1}`,
    accounts: Array.isArray(group?.accounts) ? group.accounts.map(normalizeAccount) : [],
    sortOrder: Number.isFinite(group?.sortOrder) ? Number(group.sortOrder) : groupIndex,
    createdAt: Number.isFinite(group?.createdAt) ? Number(group.createdAt) : Date.now(),
    updatedAt: Number.isFinite(group?.updatedAt) ? Number(group.updatedAt) : Date.now()
  })) : [];
  const days = [7, 14, 30, 60, 90].includes(Number(config.settings?.days)) ? Number(config.settings.days) : defaults.settings.days;
  const timeZone = config.settings?.timeZone === "Asia/Shanghai" ? "Asia/Shanghai" : "local";
  return {
    schemaVersion: 1,
    groups: groups.sort((left, right) => left.sortOrder - right.sortOrder),
    settings: {
      days,
      timeZone,
      metric: config.settings?.metric === "submissions" ? "submissions" : "solved",
      autoRefreshMinutes: Math.max(15, Number(config.settings?.autoRefreshMinutes) || 15),
      theme: ["system", "light", "dark"].includes(config.settings?.theme) ? config.settings.theme : "system"
    }
  };
}

module.exports = {
  JUDGES,
  SOURCE_SCOPES,
  SOURCE_STATUSES,
  OJMonitorError,
  aggregateDaily,
  asFiniteNumber,
  asNonEmptyString,
  buildDailyStatKey,
  buildSubmissionKey,
  classifyCodeforcesContest,
  combineStatus,
  createId,
  defaultConfig,
  inferAccepted,
  isRecord,
  mergeSubmissions,
  normalizeAccount,
  normalizeConfig,
  normalizeScope,
  normalizeSubmission,
  normalizeUsername,
  parseCodeforcesProblemUrl,
  recentDateKeys,
  shiftDateKey,
  summarizeGroup,
  zonedDateKey
};
