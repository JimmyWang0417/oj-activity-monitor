// ==UserScript==
// @name         OJ Monitor
// @namespace    https://github.com/oj-monitor/userscript
// @version      0.2.14
// @description  在本地浏览器中按人监测多个 OJ 的近期提交与过题情况
// @author       OJ Monitor contributors
// @license      GPL-3.0-only
// @match        https://codeforces.com/*
// @match        https://*.codeforces.com/*
// @match        https://codeforc.es/*
// @match        https://*.codeforc.es/*
// @match        https://atcoder.jp/*
// @match        https://vjudge.net/*
// @match        https://luogu.com.cn/*
// @match        https://www.luogu.com.cn/*
// @match        https://ac.nowcoder.com/*
// @match        https://qoj.ac/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      codeforces.com
// @connect      *.codeforces.com
// @connect      codeforc.es
// @connect      *.codeforc.es
// @connect      atcoder.jp
// @connect      kenkoooo.com
// @connect      vjudge.net
// @connect      luogu.com.cn
// @connect      www.luogu.com.cn
// @connect      ac.nowcoder.com
// @connect      qoj.ac
// ==/UserScript==

(function (global) {
  "use strict";
  const __modules = {
"src/main.js": function(module, exports, __require) {
"use strict";

const core = __require("src/core.js");
const adapters = __require("src/adapters/index.js");
const app = __require("src/app.js");
const request = __require("src/request.js");
const scheduler = __require("src/scheduler.js");
const service = __require("src/service.js");
const siteBridge = __require("src/site-bridge.js");
const storage = __require("src/storage.js");
const ui = __require("src/ui.js");
const viewModel = __require("src/view-model.js");

const api = Object.freeze({
    version: "0.2.14",
  ...adapters,
  ...app,
  ...core,
  ...request,
  ...scheduler,
  ...service,
  ...siteBridge,
  ...storage,
  ...ui,
  ...viewModel
});

if (typeof document !== "undefined" && !globalThis.__OJMON_TEST__) {
  const start = async () => {
    try {
      const application = await new app.OJMonitorApplication(globalThis).start();
      globalThis.__OJ_MONITOR_APP__ = application;
      if (globalThis.__OJMON_SMOKE_OPEN__) await application.panel.open();
    } catch (error) {
      console.error("[OJ Monitor] 初始化失败", error);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

module.exports = api;

},
"src/core.js": function(module, exports, __require) {
"use strict";

const JUDGES = Object.freeze(["codeforces", "atcoder", "vjudge", "luogu", "nowcoder", "qoj"]);
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
  if (judge === "nowcoder") return text === "答案正确";
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

},
"src/adapters/index.js": function(module, exports, __require) {
"use strict";

const { AtCoderAdapter } = __require("src/adapters/atcoder.js");
const { CodeforcesAdapter } = __require("src/adapters/codeforces.js");
const { LuoguAdapter } = __require("src/adapters/luogu.js");
const { NowcoderAdapter } = __require("src/adapters/nowcoder.js");
const { QojAdapter } = __require("src/adapters/qoj.js");
const { VJudgeAdapter } = __require("src/adapters/vjudge.js");

function createAdapters(options) {
  return {
    codeforces: new CodeforcesAdapter(options),
    atcoder: new AtCoderAdapter(options),
    vjudge: new VJudgeAdapter(options),
    luogu: new LuoguAdapter(options),
    nowcoder: new NowcoderAdapter(options),
    qoj: new QojAdapter(options)
  };
}

module.exports = { AtCoderAdapter, CodeforcesAdapter, LuoguAdapter, NowcoderAdapter, QojAdapter, VJudgeAdapter, createAdapters };

},
"src/adapters/atcoder.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError } = __require("src/core.js");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = __require("src/adapters/common.js");

const API = "https://kenkoooo.com/atcoder/atcoder-api/v3/user/submissions";

function normalizeAtCoderSubmission(record, options) {
  const id = requireText(record?.id, "AtCoder submission.id");
  const epochSecond = requireFinite(record?.epoch_second, "AtCoder epoch_second");
  const contest = requireText(record?.contest_id, "AtCoder contest_id");
  const problem = requireText(record?.problem_id, "AtCoder problem_id");
  const verdict = requireText(record?.result, "AtCoder result");
  return {
    groupId: options.groupId,
    accountId: options.accountId,
    judge: "atcoder",
    scope: "default",
    username: options.username,
    submissionId: id,
    problemKey: `atcoder:${contest}:${problem}`,
    problemUrl: `https://atcoder.jp/contests/${encodeURIComponent(contest)}/tasks/${encodeURIComponent(problem)}`,
    submittedAt: epochSecond * 1000,
    verdict,
    accepted: verdict === "AC"
  };
}

class AtCoderAdapter {
  constructor(options) {
    this.id = "atcoder";
    this.displayName = "AtCoder";
    this.client = options.client;
    this.limiter = options.limiter;
    this.pageSize = options.pageSize || 500;
    this.maxPages = options.maxPages || 100;
  }

  async validateUser(username, options = {}) {
    try {
      await this.limiter?.waitTurn("atcoder.jp", 500);
      await this.client.request(`https://atcoder.jp/users/${encodeURIComponent(username)}`, { signal: options.signal });
      return { exists: true, canonicalUsername: username, status: "ok" };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async fetchSubmissions(options) {
    const byId = new Map();
    let cursor = Math.floor(options.from / 1000);
    let previousSignature = "";
    let stopReason = "page-limit";
    let complete = false;
    try {
      for (let page = 0; page < this.maxPages; page += 1) {
        await this.limiter?.waitTurn("kenkoooo.com", 1000);
        const query = new URLSearchParams({ user: options.username, from_second: String(cursor) });
        const { data } = await this.client.json(`${API}?${query}`, { signal: options.signal });
        const records = requireArray(data, "AtCoderProblems submissions");
        const before = byId.size;
        let maximumSecond = cursor;
        for (const record of records) {
          const normalized = normalizeAtCoderSubmission(record, options);
          maximumSecond = Math.max(maximumSecond, Number(record.epoch_second));
          if (normalized.submittedAt >= options.from && normalized.submittedAt <= options.to) byId.set(normalized.submissionId, normalized);
        }
        if (records.length < this.pageSize) {
          complete = true;
          stopReason = "short-page";
          break;
        }
        const signature = `${maximumSecond}:${records.map((record) => String(record.id)).join(",")}`;
        if (signature === previousSignature || (maximumSecond === cursor && byId.size === before)) {
          stopReason = "same-second-saturation";
          break;
        }
        if (maximumSecond * 1000 > options.to) {
          complete = true;
          stopReason = "reached-to";
          break;
        }
        previousSignature = signature;
        cursor = maximumSecond;
      }
      return makeResult(options, {
        judge: "atcoder",
        scope: "default",
        status: complete ? "ok" : "partial",
        complete,
        submissions: [...byId.values()],
        nextCursor: String(cursor),
        reason: complete ? undefined : stopReason,
        warning: stopReason === "same-second-saturation" ? "AtCoderProblems 同一秒达到 500 条上限，数据可能不完整" : complete ? undefined : "AtCoderProblems 分页达到安全上限",
        diagnostics: { stopReason, adapterVersion: "atcoder-problems-v3" }
      });
    } catch (error) {
      if (error instanceof OJMonitorError && error.status === "network-error") {
        error.status = "source-unavailable";
      }
      return failureResult(options, "atcoder", "default", error, {
        submissions: [...byId.values()],
        diagnostics: { stopReason: "request-error", adapterVersion: "atcoder-problems-v3" }
      });
    }
  }
}

module.exports = { AtCoderAdapter, normalizeAtCoderSubmission };

},
"src/adapters/common.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError, mergeSubmissions } = __require("src/core.js");

function makeResult(options, overrides = {}) {
  const complete = overrides.complete !== false;
  return {
    groupId: options.groupId,
    accountId: options.accountId,
    judge: overrides.judge,
    scope: overrides.scope || options.scope || "default",
    username: options.username,
    status: overrides.status || (complete ? "ok" : "partial"),
    updatedAt: overrides.updatedAt || Date.now(),
    submissions: mergeSubmissions([], overrides.submissions || []),
    nextCursor: overrides.nextCursor,
    excludedCount: Number(overrides.excludedCount || 0),
    coverage: {
      from: options.from,
      to: options.to,
      complete,
      reason: overrides.reason
    },
    warning: overrides.warning,
    diagnostics: overrides.diagnostics
  };
}

function errorStatus(error, fallback = "network-error") {
  return error instanceof OJMonitorError ? error.status : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "未知错误");
}

function failureResult(options, judge, scope, error, overrides = {}) {
  return makeResult(options, {
    judge,
    scope,
    status: overrides.status || errorStatus(error),
    complete: false,
    reason: overrides.reason || errorMessage(error),
    warning: overrides.warning || errorMessage(error),
    submissions: overrides.submissions || [],
    excludedCount: overrides.excludedCount || 0,
    diagnostics: overrides.diagnostics
  });
}

function validationFailure(error) {
  return { exists: null, status: errorStatus(error), message: errorMessage(error) };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new OJMonitorError("schema-changed", `${label} 不是数组`);
  return value;
}

function requireFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new OJMonitorError("schema-changed", `${label} 不是有效数字`);
  return number;
}

function requireText(value, label) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new OJMonitorError("schema-changed", `${label} 缺失`);
  }
  return String(value).trim();
}

module.exports = {
  errorMessage,
  errorStatus,
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
};

},
"src/adapters/codeforces.js": function(module, exports, __require) {
"use strict";

const {
  OJMonitorError,
  classifyCodeforcesContest,
  mergeSubmissions,
  parseCodeforcesProblemUrl
} = __require("src/core.js");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = __require("src/adapters/common.js");

const API = "https://codeforces.com/api";
const CONTEST_CACHE_TTL = 24 * 60 * 60 * 1000;

function cfApiError(data) {
  if (!data || data.status !== "OK") {
    const message = String(data?.comment || "Codeforces API 响应异常");
    const status = /not found/i.test(message) ? "not-found" : /limit exceeded/i.test(message) ? "rate-limited" : "source-unavailable";
    throw new OJMonitorError(status, message);
  }
  return data.result;
}

function normalizeCodeforcesSubmission(record, options, scope) {
  const id = requireText(record?.id, "Codeforces submission.id");
  const contestId = requireFinite(record?.contestId ?? record?.problem?.contestId, "Codeforces contestId");
  const index = requireText(record?.problem?.index, "Codeforces problem.index");
  const submittedAt = requireFinite(record?.creationTimeSeconds, "Codeforces creationTimeSeconds") * 1000;
  return {
    groupId: options.groupId,
    accountId: options.accountId,
    judge: "codeforces",
    scope,
    username: options.username,
    submissionId: id,
    problemKey: `codeforces:${scope}:${contestId}:${index}`,
    problemName: typeof record.problem?.name === "string" ? record.problem.name : undefined,
    problemUrl: scope === "gym"
      ? `https://codeforces.com/gym/${contestId}/problem/${encodeURIComponent(index)}`
      : `https://codeforces.com/problemset/problem/${contestId}/${encodeURIComponent(index)}`,
    submittedAt,
    verdict: typeof record.verdict === "string" ? record.verdict : "UNKNOWN",
    accepted: record.verdict === "OK"
  };
}

function parseCfTime(text) {
  const match = String(text).trim().match(/^([A-Z][a-z]{2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]} ${match[2]} ${match[3]} ${match[4]}:${match[5]}:00`);
}

function stripHtml(value) {
  return String(value).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function parseVisibleSubmissionHtml(html, options, gymContestIds) {
  const submissions = [];
  const rowExpression = /<tr\b[^>]*data-submission-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowExpression.exec(String(html)))) {
    const id = row[1];
    const body = row[2];
    const link = body.match(/href=["']([^"']*\/(?:gym|contest|problemset)\/[^"']*\/problem\/[^"']+)["']/i);
    if (!link) continue;
    const problem = parseCodeforcesProblemUrl(link[1]);
    if (!problem || problem.scope !== "gym" || !gymContestIds.has(Number(problem.contestId))) continue;
    const time = body.match(/class=["'][^"']*format-time[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const submittedAt = parseCfTime(stripHtml(time?.[1] || ""));
    if (!Number.isFinite(submittedAt)) continue;
    const verdict = body.match(/submissionVerdict=["']([^"']+)["']/i)?.[1] || "UNKNOWN";
    const label = stripHtml(body.match(/href=["'][^"']*\/problem\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");
    submissions.push({
      groupId: options.groupId,
      accountId: options.accountId,
      judge: "codeforces",
      scope: "gym",
      username: options.username,
      submissionId: id,
      problemKey: problem.problemKey,
      problemName: label.replace(/^\S+\s+-\s+/, "") || undefined,
      problemUrl: problem.canonicalUrl,
      submittedAt,
      verdict,
      accepted: verdict === "OK"
    });
  }
  return submissions;
}

class CodeforcesAdapter {
  constructor(options) {
    this.id = "codeforces";
    this.displayName = "Codeforces";
    this.client = options.client;
    this.store = options.store;
    this.limiter = options.limiter;
    this.pageSize = options.pageSize || 1000;
    this.maxPages = options.maxPages || 100;
  }

  async api(method, parameters, signal) {
    await this.limiter?.waitTurn("codeforces.com", 2000);
    const query = new URLSearchParams(parameters);
    const { data } = await this.client.json(`${API}/${method}?${query}`, { signal });
    try {
      return cfApiError(data);
    } catch (error) {
      if (error.status === "rate-limited") await this.limiter?.coolDown("codeforces.com", 10000);
      throw error;
    }
  }

  async validateUser(username, options = {}) {
    try {
      const users = requireArray(await this.api("user.info", { handles: username }, options.signal), "Codeforces user.info result");
      if (!users.length) return { exists: false, status: "not-found" };
      return { exists: true, canonicalUsername: requireText(users[0].handle, "Codeforces handle"), status: "ok" };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async getContestKinds(signal) {
    if (this.contestKindsPromise) return this.contestKindsPromise;
    this.contestKindsPromise = this.loadContestKinds(signal);
    try {
      return await this.contestKindsPromise;
    } finally {
      this.contestKindsPromise = null;
    }
  }

  async loadContestKinds(signal) {
    const cached = await this.store?.get("adapter:codeforces:contest-kinds", null);
    if (cached && Date.now() - cached.refreshedAt < CONTEST_CACHE_TTL && Array.isArray(cached.gym) && Array.isArray(cached.regular)) {
      return { gymContestIds: new Set(cached.gym), regularContestIds: new Set(cached.regular), refreshedAt: cached.refreshedAt, version: cached.version };
    }
    const [gym, regular] = await Promise.all([
      this.api("contest.list", { gym: "true" }, signal),
      this.api("contest.list", { gym: "false" }, signal)
    ]);
    requireArray(gym, "Codeforces Gym contest.list");
    requireArray(regular, "Codeforces regular contest.list");
    const gymIds = new Set(gym.map((contest) => requireFinite(contest.id, "contest.id")));
    const regularIds = new Set(regular.map((contest) => requireFinite(contest.id, "contest.id")));
    for (const id of [...gymIds]) {
      if (regularIds.has(id)) {
        gymIds.delete(id);
        regularIds.delete(id);
      }
    }
    const value = {
      gym: [...gymIds], regular: [...regularIds], refreshedAt: Date.now(),
      version: `${gym.length}:${regular.length}`
    };
    await this.store?.setAtomic("adapter:codeforces:contest-kinds", value);
    return { gymContestIds: gymIds, regularContestIds: regularIds, refreshedAt: value.refreshedAt, version: value.version };
  }

  canUseVisibleGymSupplement() {
    const location = this.client.global?.location;
    return Boolean(location && /((^|\.)codeforces\.com|(^|\.)codeforc\.es)$/i.test(location.hostname || ""));
  }

  visibleSiteBase() {
    return this.canUseVisibleGymSupplement() ? this.client.global.location.origin : "https://codeforces.com";
  }

  async fetchPublicMixed(options) {
    const records = [];
    let fromIndex = 1;
    let stopReason = "empty-page";
    for (let page = 0; page < this.maxPages; page += 1) {
      const result = requireArray(await this.api("user.status", {
        handle: options.username,
        from: String(fromIndex),
        count: String(this.pageSize)
      }, options.signal), "Codeforces user.status result");
      if (!result.length) break;
      for (const record of result) {
        requireFinite(record?.creationTimeSeconds, "Codeforces creationTimeSeconds");
        records.push(record);
      }
      const oldest = Math.min(...result.map((record) => Number(record.creationTimeSeconds) * 1000));
      if (oldest < options.from) {
        stopReason = "reached-from";
        break;
      }
      if (result.length < this.pageSize) {
        stopReason = "short-page";
        break;
      }
      fromIndex += result.length;
      stopReason = "page-limit";
    }
    records.stopReason = stopReason;
    return records;
  }

  splitByContestKind(records, options, contestKinds) {
    const buckets = { problemset: [], gym: [] };
    let excludedCount = 0;
    for (const record of records) {
      const submittedAt = requireFinite(record?.creationTimeSeconds, "Codeforces creationTimeSeconds") * 1000;
      if (submittedAt < options.from || submittedAt > options.to) continue;
      const contestId = record?.contestId ?? record?.problem?.contestId;
      const scope = classifyCodeforcesContest({
        contestId,
        gymContestIds: contestKinds.gymContestIds,
        regularContestIds: contestKinds.regularContestIds
      });
      if (scope === "unsupported") {
        excludedCount += 1;
        continue;
      }
      const normalized = normalizeCodeforcesSubmission(record, options, scope);
      if (normalized.submittedAt >= options.from && normalized.submittedAt <= options.to) buckets[scope].push(normalized);
    }
    const partial = excludedCount > 0 || records.stopReason === "page-limit";
    const warning = excludedCount ? `存在 ${excludedCount} 条无法按权威比赛集合归类的记录` : records.stopReason === "page-limit" ? "Codeforces 分页达到安全上限" : undefined;
    const shared = { complete: !partial, status: partial ? "partial" : "ok", reason: warning, warning };
    return {
      problemset: makeResult({ ...options, scope: "problemset" }, {
        ...shared, judge: "codeforces", scope: "problemset", submissions: buckets.problemset, excludedCount,
        diagnostics: { stopReason: records.stopReason, contestIndexVersion: contestKinds.version }
      }),
      gym: makeResult({ ...options, scope: "gym" }, {
        ...shared, judge: "codeforces", scope: "gym", submissions: buckets.gym, excludedCount: 0,
        diagnostics: { stopReason: records.stopReason, contestIndexVersion: contestKinds.version }
      })
    };
  }

  async fetchVisibleGymSupplement(options, contestKinds) {
    if (!this.canUseVisibleGymSupplement()) {
      return makeResult(options, {
        judge: "codeforces", scope: "gym", status: "partial", complete: false, submissions: [],
        reason: "Gym 会话补充仅在 Codeforces 同源页面启用",
        warning: "请在 Codeforces 页面打开面板以补充本地账号可见 Gym"
      });
    }
    try {
      const collected = [];
      let stopReason = "page-limit";
      for (let page = 1; page <= 10; page += 1) {
        await this.limiter?.waitTurn("codeforces.com", 2000);
        const response = await this.client.request(`${this.visibleSiteBase()}/submissions/${encodeURIComponent(options.username)}/page/${page}`, { signal: options.signal });
        const parsed = parseVisibleSubmissionHtml(response.text, options, contestKinds.gymContestIds);
        collected.push(...parsed);
        if (!parsed.length) {
          stopReason = "empty-page";
          break;
        }
        if (Math.min(...parsed.map((item) => item.submittedAt)) < options.from) {
          stopReason = "reached-from";
          break;
        }
      }
      return makeResult(options, {
        judge: "codeforces", scope: "gym", status: "partial", complete: false,
        submissions: collected.filter((item) => item.submittedAt >= options.from && item.submittedAt <= options.to),
        reason: "浏览器页面补充的时间受 Codeforces 显示时区影响",
        warning: "Gym 页面补充为降级数据，数值是已知下界",
        diagnostics: { stopReason, source: "browser-visible-submissions-html" }
      });
    } catch (error) {
      return failureResult(options, "codeforces", "gym", error, { reason: `Gym 页面补充失败：${error.message}` });
    }
  }

  async fetchBoth(options) {
    try {
      const contestKinds = await this.getContestKinds(options.signal);
      const records = await this.fetchPublicMixed(options);
      return this.splitByContestKind(records, options, contestKinds);
    } catch (error) {
      return {
        problemset: failureResult({ ...options, scope: "problemset" }, "codeforces", "problemset", error),
        gym: failureResult({ ...options, scope: "gym" }, "codeforces", "gym", error)
      };
    }
  }

  async fetchSubmissions(options) {
    const both = await this.fetchBoth(options);
    const selected = both[options.scope];
    if (options.scope !== "gym" || selected.status !== "ok") return selected;
    const contestKinds = await this.getContestKinds(options.signal);
    const supplement = await this.fetchVisibleGymSupplement(options, contestKinds);
    if (!supplement.submissions.length) return selected;
    return { ...selected, submissions: mergeSubmissions(selected.submissions, supplement.submissions), warning: supplement.warning };
  }
}

module.exports = {
  CodeforcesAdapter,
  cfApiError,
  normalizeCodeforcesSubmission,
  parseVisibleSubmissionHtml
};

},
"src/adapters/luogu.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError, isRecord } = __require("src/core.js");
const { isSameOrigin, pageTransportCapability } = __require("src/request.js");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = __require("src/adapters/common.js");

// Pages are time-ordered and are fetched until options.from is crossed.
// A page limit is only used when explicitly injected for testing/diagnostics.
const DEFAULT_MAX_PAGES = null;

function diagnosticFinalLocation(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function diagnosticReason(error) {
  if (!error) return undefined;
  return String(error.message || error)
    .replace(/https?:\/\/\S+/gi, (value) => diagnosticFinalLocation(value) || "[url]")
    .slice(0, 240);
}

function parseLentilleContextHtml(text) {
  const match = String(text).match(/<script\b(?=[^>]*\bid\s*=\s*(["'])lentille-context\1)[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!match) return null;
  const jsonText = match[2].trim();
  if (!jsonText) throw new OJMonitorError("schema-changed", "洛谷记录页的 lentille-context 为空");
  try {
    return JSON.parse(jsonText);
  } catch (cause) {
    throw new OJMonitorError("schema-changed", "洛谷记录页的 lentille-context 不是有效 JSON", { cause });
  }
}

function assertNotLuoguAuthPayload(payload) {
  if (payload?.instance === "auth" || payload?.template === "login" || payload?.template === "auth.login") {
    throw new OJMonitorError("login-required", "请先在洛谷登录并完成验证，再从洛谷页面重新获取");
  }
  return payload;
}

function parseLuoguContentResponse(response) {
  const text = String(response?.text ?? "");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    const embeddedPayload = parseLentilleContextHtml(text);
    if (embeddedPayload) return assertNotLuoguAuthPayload(embeddedPayload);
    const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text);
    const finalUrl = String(response?.finalUrl || "");
    const looksLikeLogin = /\/(?:auth\/)?login(?:[/?#]|$)/i.test(finalUrl) ||
      /\/(?:auth\/)?login(?:[?"'#\s/>]|$)/i.test(text) ||
      /<form\b[^>]*(?:action=["'][^"']*login|id=["'][^"']*login)/i.test(text);
    const looksLikeVerification = /\bC3VK\b|ws-action|challenge-platform|Just a moment|Enable JavaScript and cookies/i.test(text);
    if (looksLikeVerification) {
      throw new OJMonitorError("verification-required", "洛谷返回了浏览器验证页；请打开洛谷完成验证后，从洛谷页面重新获取", { cause });
    }
    if (looksLikeLogin) {
      throw new OJMonitorError("login-required", "洛谷记录接口返回了明确的登录页；请打开洛谷登录并完成验证后重新获取", { cause });
    }
    if (looksLikeHtml) {
      throw new OJMonitorError("schema-changed", "洛谷记录页返回了 HTML，但其中没有可解析的 lentille-context；这不等同于未登录", { cause });
    }
    throw new OJMonitorError("schema-changed", "洛谷 content-only 响应既不是 JSON 也不是可识别的登录/验证页", { cause });
  }
  return assertNotLuoguAuthPayload(payload);
}

function luoguFailureWarning(error) {
  if (["login-required", "verification-required"].includes(error?.status)) {
    return "已尝试页面会话、油猴请求和跨标签页代理，但洛谷仍返回登录/验证页；若已确认登录，请打开“诊断”并复制洛谷 transportAttempts";
  }
  return error instanceof Error ? error.message : String(error || "洛谷获取失败");
}

function findRecordArray(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (!value.length) return value;
    const score = value.filter((item) => isRecord(item) && (
      "submitTime" in item || "submitTimeMs" in item ||
      ("status" in item && ("problem" in item || "problemId" in item || "pid" in item))
    )).length;
    if (score > 0) return value;
    for (const child of value) {
      const found = findRecordArray(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const priorityKeys = ["result", "records", "currentData", "data"];
  for (const key of priorityKeys) {
    if (key in value) {
      const found = findRecordArray(value[key], depth + 1);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = findRecordArray(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findRecordPage(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (isRecord(value) && Array.isArray(value.result)) {
    const records = findRecordArray(value.result);
    if (records) {
      const numericCount = Number(value.count);
      return { records, totalCount: Number.isFinite(numericCount) && numericCount >= 0 ? numericCount : undefined };
    }
  }
  if (!isRecord(value)) return null;
  for (const key of ["records", "currentData", "data", "result"]) {
    if (!(key in value)) continue;
    const found = findRecordPage(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findRecordPage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeLuoguSubmission(record, options) {
  const id = requireText(record?.id ?? record?.rid, "洛谷记录 id");
  const problem = record?.problem;
  const problemId = requireText(problem?.pid ?? problem?.id ?? record?.problemId ?? record?.pid, "洛谷题号");
  const submitSeconds = requireFinite(record?.submitTime ?? record?.time, "洛谷 submitTime(s)");
  const rawStatus = record?.status;
  const numericStatus = Number(rawStatus);
  const statusText = typeof rawStatus === "string" ? rawStatus.trim() : "";
  if (!Number.isFinite(numericStatus) && !statusText) {
    throw new OJMonitorError("schema-changed", "洛谷 recordStatus 缺失或类型无效");
  }
  const accepted = numericStatus === 12 || /^(?:AC|Accepted)$/i.test(statusText);
  return {
    groupId: options.groupId,
    accountId: options.accountId,
    judge: "luogu",
    scope: "default",
    username: options.username,
    submissionId: id,
    problemKey: `luogu:${problemId}`,
    problemName: typeof problem?.title === "string" ? problem.title : undefined,
    problemUrl: `https://www.luogu.com.cn/problem/${encodeURIComponent(problemId)}`,
    submittedAt: submitSeconds * 1000,
    verdict: accepted ? "AC" : Number.isFinite(numericStatus) ? `recordStatus:${numericStatus}` : statusText,
    accepted
  };
}

class LuoguAdapter {
  constructor(options) {
    this.id = "luogu";
    this.displayName = "洛谷";
    this.client = options.client;
    this.limiter = options.limiter;
    this.maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES;
    this.uidCache = new Map();
  }

  siteBase() {
    return "https://www.luogu.com.cn";
  }

  async requestRecordPayload(url, requestOptions) {
    const sameOrigin = isSameOrigin(url, this.client.global?.location);
    const pageCapability = pageTransportCapability(this.client.global);
    const hasPageTransport = sameOrigin && pageCapability.available;
    const hasGmTransport = typeof this.client.global?.GM_xmlhttpRequest === "function";
    const hasSiteBridge = Boolean(this.client.siteBridge);
    const transports = [
      ...(hasPageTransport ? ["page-fetch"] : []),
      ...(hasGmTransport ? ["gm-xhr"] : []),
      ...(!sameOrigin && hasSiteBridge ? ["site-bridge"] : []),
      ...(sameOrigin || (!hasGmTransport && !hasSiteBridge) ? [undefined] : [])
    ];
    const attemptedTransports = [];
    const transportAttempts = [];
    if (!sameOrigin) {
      transportAttempts.push({
        requested: "page-fetch",
        actual: "not-attempted",
        status: "unavailable",
        reason: "当前标签页与 www.luogu.com.cn 不同源"
      });
    } else if (!pageCapability.available) {
      transportAttempts.push({
        requested: "page-fetch",
        actual: "not-attempted",
        status: "unavailable",
        reason: pageCapability.reason
      });
    }
    for (let index = 0; index < transports.length; index += 1) {
      const transport = transports[index];
      const transportName = transport || "auto";
      attemptedTransports.push(transportName);
      try {
        const response = await this.client.request(url, { ...requestOptions, ...(transport ? { transport } : {}) });
        let payload;
        try {
          payload = parseLuoguContentResponse(response);
        } catch (error) {
          if (error && typeof error === "object") {
            error.details = {
              ...(error.details || {}),
              transport: response.transport || transportName,
              finalUrl: response.finalUrl || url,
              httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : undefined
            };
          }
          throw error;
        }
        transportAttempts.push({
          requested: transportName,
          actual: response.transport || transportName,
          status: "ok",
          httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : undefined,
          ...(response.transportFallback ? { fallback: response.transportFallback } : {}),
          finalLocation: diagnosticFinalLocation(response.finalUrl || url)
        });
        return {
          payload,
          transport: response.transport || transportName,
          attemptedTransports,
          transportAttempts
        };
      } catch (error) {
        transportAttempts.push({
          requested: transportName,
          actual: error?.details?.transport || transportName,
          status: error?.status || "network-error",
          httpStatus: error?.details?.httpStatus,
          reason: diagnosticReason(error),
          ...(error?.details?.transportFallback ? { fallback: error.details.transportFallback } : {}),
          finalLocation: diagnosticFinalLocation(error?.details?.finalUrl)
        });
        const canFallback = index < transports.length - 1 && [
          "login-required", "verification-required", "source-unavailable", "network-error", "schema-changed"
        ].includes(error?.status);
        if (canFallback) {
          continue;
        }
        if (error && typeof error === "object") {
          error.details = {
            ...(error.details || {}),
            transport: error.details?.transport || transportName,
            attemptedTransports: [...attemptedTransports],
            transportAttempts: [...transportAttempts]
          };
        }
        throw error;
      }
    }
    throw new OJMonitorError("network-error", "洛谷记录请求没有可用传输方式", { attemptedTransports });
  }

  async resolveUser(username, signal) {
    if (/^\d+$/.test(username)) return { uid: username, name: username };
    if (this.uidCache.has(username)) return this.uidCache.get(username);
    await this.limiter?.waitTurn("luogu.com.cn", 500);
    const { data } = await this.client.json(`${this.siteBase()}/api/user/search?keyword=${encodeURIComponent(username)}`, { signal });
    const users = requireArray(data?.users, "洛谷用户搜索 users");
    const user = users.find((item) => String(item?.name || "").toLowerCase() === username.toLowerCase()) || users[0];
    if (!user) throw new OJMonitorError("not-found", "洛谷用户不存在");
    const result = { uid: requireText(user.uid, "洛谷 uid"), name: requireText(user.name, "洛谷用户名") };
    this.uidCache.set(username, result);
    return result;
  }

  async validateUser(username, options = {}) {
    try {
      if (/^\d+$/.test(username)) {
        await this.limiter?.waitTurn("luogu.com.cn", 500);
        await this.client.request(`${this.siteBase()}/user/${encodeURIComponent(username)}`, { signal: options.signal });
        return { exists: true, canonicalUsername: username, userId: username, status: "ok" };
      }
      const user = await this.resolveUser(username, options.signal);
      return { exists: true, canonicalUsername: user.name, userId: user.uid, status: "ok" };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async fetchSubmissions(options) {
    const submissions = [];
    const pageSignatures = new Set();
    const seenRecordIds = new Set();
    let stopReason = "unknown";
    let pageSize;
    let totalCount;
    let pagesFetched = 0;
    let previousOldest = Infinity;
    let transportUsed;
    let attemptedTransports;
    let transportAttempts;
    try {
      const user = await this.resolveUser(options.username, options.signal);
      for (let page = 1; ; page += 1) {
        if (this.maxPages !== null && page > this.maxPages) {
          stopReason = "page-limit";
          break;
        }
        await this.limiter?.waitTurn("luogu.com.cn", 500);
        const pageResponse = await this.requestRecordPayload(`${this.siteBase()}/record/list?user=${encodeURIComponent(user.uid)}&page=${page}&_contentOnly=1`, {
          signal: options.signal,
          headers: {
            "x-luogu-type": "content-only",
            "x-requested-with": "XMLHttpRequest",
            accept: "application/json, text/plain, */*"
          }
        });
        const { payload } = pageResponse;
        transportUsed = pageResponse.transport;
        attemptedTransports = pageResponse.attemptedTransports;
        transportAttempts = pageResponse.transportAttempts;
        const recordPage = findRecordPage(payload);
        if (!recordPage) throw new OJMonitorError("schema-changed", "洛谷响应中找不到带分页信息的记录列表");
        const { records } = recordPage;
        pagesFetched += 1;
        if (!records.length) {
          stopReason = "empty-page";
          break;
        }
        const ids = records.map((record) => requireText(record?.id ?? record?.rid, "洛谷记录 id"));
        const signature = ids.join(",");
        if (pageSignatures.has(signature)) {
          stopReason = "repeated-page";
          break;
        }
        pageSignatures.add(signature);
        if (ids.some((id) => seenRecordIds.has(id))) {
          stopReason = "overlapping-pages";
          break;
        }
        ids.forEach((id) => seenRecordIds.add(id));
        if (page === 1) {
          pageSize = records.length;
          totalCount = recordPage.totalCount;
        } else if (Number.isFinite(recordPage.totalCount) && Number.isFinite(totalCount) && recordPage.totalCount !== totalCount) {
          throw new OJMonitorError("partial", "洛谷采集期间记录总数发生变化，请重新获取", {
            previousTotal: totalCount,
            currentTotal: recordPage.totalCount
          });
        }
        let oldest = Infinity;
        let newest = -Infinity;
        let previousInPage = Infinity;
        for (const record of records) {
          const normalized = normalizeLuoguSubmission(record, options);
          if (normalized.submittedAt > previousInPage) {
            throw new OJMonitorError("schema-changed", "洛谷记录不再按提交时间倒序排列，不能证明分页完整");
          }
          previousInPage = normalized.submittedAt;
          oldest = Math.min(oldest, normalized.submittedAt);
          newest = Math.max(newest, normalized.submittedAt);
          if (normalized.submittedAt >= options.from && normalized.submittedAt <= options.to) submissions.push(normalized);
        }
        if (newest > previousOldest) {
          throw new OJMonitorError("schema-changed", "洛谷跨页记录顺序异常，不能证明分页完整");
        }
        previousOldest = oldest;
        if (oldest < options.from) {
          stopReason = "reached-from";
          break;
        }
        const totalPages = Number.isFinite(totalCount) && pageSize ? Math.max(1, Math.ceil(totalCount / pageSize)) : undefined;
        if (totalPages && page >= totalPages) {
          stopReason = "last-page";
          break;
        }
        if (pageSize && records.length < pageSize) {
          stopReason = "short-page";
          break;
        }
      }
      const countMismatch = ["empty-page", "short-page", "last-page"].includes(stopReason) &&
        Number.isFinite(totalCount) && seenRecordIds.size < totalCount;
      if (countMismatch) stopReason = "count-mismatch";
      const complete = !["page-limit", "repeated-page", "overlapping-pages", "count-mismatch", "unknown"].includes(stopReason);
      const warning = stopReason === "page-limit"
        ? `洛谷分页达到配置的 ${this.maxPages} 页上限`
        : stopReason === "repeated-page"
          ? "洛谷返回了重复分页，无法证明更早记录已覆盖"
          : stopReason === "overlapping-pages"
            ? "洛谷分页出现重叠记录，采集期间列表可能发生变化"
            : stopReason === "count-mismatch"
              ? `洛谷声明共有 ${totalCount} 条记录，但分页仅取得 ${seenRecordIds.size} 条且未越过查询起点`
          : undefined;
      return makeResult(options, {
        judge: "luogu", scope: "default", status: complete ? "ok" : "partial", complete,
        submissions, reason: complete ? undefined : stopReason,
        warning,
        diagnostics: {
          stopReason,
          source: "legacy-data-response",
          pageOrigin: this.client.global?.location?.origin,
          transport: transportUsed,
          attemptedTransports,
          transportAttempts,
          pagesFetched,
          pageSize,
          totalCount
        }
      });
    } catch (error) {
      return failureResult(options, "luogu", "default", error, {
        submissions,
        warning: luoguFailureWarning(error),
        diagnostics: {
          stopReason: error.status || "request-error",
          source: "legacy-data-response",
          pageOrigin: this.client.global?.location?.origin,
          transport: transportUsed || error.details?.transport,
          attemptedTransports: attemptedTransports || error.details?.attemptedTransports,
          transportAttempts: transportAttempts || error.details?.transportAttempts,
          pagesFetched,
          pageSize,
          totalCount
        }
      });
    }
  }
}

module.exports = {
  DEFAULT_MAX_PAGES,
  LuoguAdapter,
  diagnosticFinalLocation,
  diagnosticReason,
  findRecordArray,
  findRecordPage,
  luoguFailureWarning,
  normalizeLuoguSubmission,
  parseLentilleContextHtml,
  parseLuoguContentResponse
};

},
"src/request.js": function(module, exports, __require) {
"use strict";

const { createId, OJMonitorError } = __require("src/core.js");

const PAGE_REALM_STATES = new WeakMap();

function parseHeaderText(text = "") {
  const headers = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
}

function responseHeader(response, name) {
  const normalized = name.toLowerCase();
  if (response.headers instanceof Map) return response.headers.get(normalized) || "";
  if (response.headers && typeof response.headers.get === "function") return response.headers.get(name) || "";
  return "";
}

function classifyResponse(response, requestedUrl) {
  const status = Number(response.status || 0);
  const text = String(response.text ?? response.responseText ?? "");
  const finalUrl = String(response.finalUrl || requestedUrl || "");
  const location = responseHeader(response, "location");
  const server = responseHeader(response, "server").toLowerCase();
  const cfMitigated = responseHeader(response, "cf-mitigated").toLowerCase();
  const wsAction = responseHeader(response, "ws-action").toLowerCase();
  const isCloudflare = server.includes("cloudflare") || Boolean(responseHeader(response, "cf-ray"));

  let redirectedUrl = "";
  try {
    redirectedUrl = location ? new URL(location, finalUrl || requestedUrl).href : "";
  } catch {
    redirectedUrl = location;
  }
  if (/\/(?:auth\/)?login(?:[/?#]|$)/i.test(finalUrl) || /\/(?:auth\/)?login(?:[/?#]|$)/i.test(redirectedUrl)) {
    return new OJMonitorError("login-required", "需要先登录目标 OJ", { status, finalUrl });
  }
  if (wsAction === "cc") {
    return new OJMonitorError("verification-required", "目标站点需要浏览器验证", { status, finalUrl, protection: "wangsu" });
  }
  if (
    cfMitigated === "challenge" ||
    /<title>\s*Just a moment/i.test(text) ||
    /\/cdn-cgi\/challenge-platform\//i.test(text) ||
    /turnstile/i.test(text) && /cloudflare/i.test(text)
  ) {
    return new OJMonitorError("verification-required", "Cloudflare 需要浏览器验证", { status, finalUrl, protection: "cloudflare" });
  }
  if (status === 429) return new OJMonitorError("rate-limited", "请求频率过高", { status, finalUrl });
  if (status === 404) return new OJMonitorError("not-found", "用户或数据入口不存在", { status, finalUrl });
  if (status === 401) return new OJMonitorError("login-required", "需要先登录目标 OJ", { status, finalUrl });
  if (status === 403 && isCloudflare) {
    return new OJMonitorError("verification-required", "Cloudflare 拒绝了扩展请求，请在目标站点同源刷新", { status, finalUrl });
  }
  if (status === 403) return new OJMonitorError("permission-denied", "本地账号无权查看该数据", { status, finalUrl });
  if (status >= 400) return new OJMonitorError("network-error", `HTTP ${status}`, { status, finalUrl });
  return null;
}

function isSameOrigin(url, locationObject = globalThis.location) {
  if (!locationObject?.href) return false;
  try {
    return new URL(url, locationObject.href).origin === new URL(locationObject.href).origin;
  } catch {
    return false;
  }
}

function pageFetchBinding(globalObject = globalThis) {
  const lexicalContent = typeof content !== "undefined" ? content : undefined;
  const lexicalUnsafeWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : undefined;
  const candidates = [
    { owner: globalObject.content || lexicalContent, name: "firefox-content-fetch" },
    { owner: globalObject.unsafeWindow || lexicalUnsafeWindow, name: "unsafe-window-fetch" },
    { owner: globalObject.window?.wrappedJSObject, name: "wrapped-window-fetch" },
    { owner: globalObject.window === globalObject ? globalObject : undefined, name: "page-window-fetch" }
  ];
  for (const candidate of candidates) {
    if (candidate.owner && typeof candidate.owner.fetch === "function") {
      return { ...candidate, fetch: candidate.owner.fetch };
    }
  }
  return null;
}

function pageTransportCapability(globalObject = globalThis) {
  const documentObject = globalObject.document;
  const parent = documentObject?.documentElement || documentObject?.head || documentObject?.body;
  const missing = [];
  if (!parent) missing.push("document-root");
  if (typeof documentObject?.createElement !== "function") missing.push("document.createElement");
  if (typeof documentObject?.dispatchEvent !== "function") missing.push("document.dispatchEvent");
  if (typeof globalObject.CustomEvent !== "function") missing.push("CustomEvent");
  if (!missing.length) return { available: true, mode: "page-realm" };
  const binding = pageFetchBinding(globalObject);
  if (binding) {
    return {
      available: true,
      mode: "fallback-binding",
      binding: binding.name,
      pageRealmUnavailable: missing.join(", ")
    };
  }
  return {
    available: false,
    mode: "unavailable",
    reason: `缺少页面请求能力：${missing.join(", ")}`
  };
}

function pageTransportAvailable(globalObject = globalThis) {
  return pageTransportCapability(globalObject).available;
}

function plainHeaders(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => { output[String(name).toLowerCase()] = String(value); });
    return output;
  }
  for (const [name, value] of Object.entries(headers)) output[String(name).toLowerCase()] = String(value);
  return output;
}

function pageRealmCloneFunction(globalObject = globalThis) {
  const lexicalCloneInto = typeof cloneInto === "function" ? cloneInto : undefined;
  if (typeof globalObject.cloneInto === "function") return globalObject.cloneInto;
  return lexicalCloneInto;
}

function pageRealmFetchInit(globalObject, binding, options = {}) {
  const source = {
    method: options.method || "GET",
    headers: plainHeaders(options.headers),
    credentials: "include",
    redirect: options.redirect || "follow"
  };
  if (options.body !== undefined && options.body !== null) source.body = options.body;

  const clone = pageRealmCloneFunction(globalObject);
  if (clone) {
    try {
      return { value: clone(source, binding.owner), mode: "clone-into" };
    } catch {
      // Fall through to constructors from the target page realm. This keeps
      // ordinary GET requests usable even when a body cannot be cloned.
    }
  }

  const PageObject = binding.owner?.Object;
  const target = typeof PageObject === "function" ? new PageObject() : {};
  target.method = source.method;
  target.credentials = source.credentials;
  target.redirect = source.redirect;
  if (source.body !== undefined) target.body = source.body;
  const PageHeaders = binding.owner?.Headers;
  if (typeof PageHeaders === "function") {
    const headers = new PageHeaders();
    for (const [name, value] of Object.entries(source.headers)) headers.append(name, value);
    target.headers = headers;
  } else {
    const HeadersObject = typeof PageObject === "function" ? new PageObject() : {};
    for (const [name, value] of Object.entries(source.headers)) HeadersObject[name] = value;
    target.headers = HeadersObject;
  }
  return { value: target, mode: typeof PageObject === "function" ? "page-constructors" : "direct" };
}

function gmCookiePartitionOptions(options = {}) {
  // cookiePartition selects a partitioned-cookie jar; it is not a generic
  // "send cookies" switch. Leave Tampermonkey's normal cookie jar untouched
  // unless a caller explicitly supplies a partition key.
  return options.cookiePartition && typeof options.cookiePartition === "object"
    ? { cookiePartition: options.cookiePartition }
    : {};
}

// This function is serialized into a <script> element. Keep it self-contained.
function installPageRealmEndpoint(documentObject, windowObject, events) {
  if (windowObject[events.marker]) {
    documentObject.dispatchEvent(new windowObject.CustomEvent(events.ready));
    return;
  }
  Object.defineProperty(windowObject, events.marker, { value: true, configurable: false });
  const controllers = new Map();
  const reply = (payload) => documentObject.dispatchEvent(new windowObject.CustomEvent(events.response, {
    detail: JSON.stringify(payload)
  }));
  documentObject.addEventListener(events.cancel, (event) => {
    try {
      const payload = JSON.parse(String(event.detail || ""));
      controllers.get(payload.id)?.abort();
    } catch {
      // Ignore malformed or unrelated page events.
    }
  });
  documentObject.addEventListener(events.request, async (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.detail || ""));
      const url = new URL(payload.url, windowObject.location.href);
      if (url.origin !== windowObject.location.origin || payload.method !== "GET") {
        throw new Error("OJ Monitor page request rejected");
      }
      const allowedHeaders = {};
      for (const [name, value] of Object.entries(payload.headers || {})) {
        const normalized = String(name).toLowerCase();
        if (["accept", "content-type", "x-lentille-request", "x-luogu-type", "x-requested-with"].includes(normalized)) {
          allowedHeaders[normalized] = String(value);
        }
      }
      const Controller = windowObject.AbortController;
      const controller = new Controller();
      controllers.set(payload.id, controller);
      const response = await windowObject.fetch(url.href, {
        method: "GET",
        headers: allowedHeaders,
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      });
      const headers = [];
      response.headers.forEach((value, name) => headers.push([String(name).toLowerCase(), String(value)]));
      reply({
        id: payload.id,
        ok: true,
        status: response.status,
        finalUrl: response.url || url.href,
        headers,
        text: await response.text()
      });
    } catch (error) {
      if (payload?.id) {
        reply({ id: payload.id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (payload?.id) controllers.delete(payload.id);
    }
  });
  documentObject.dispatchEvent(new windowObject.CustomEvent(events.ready));
}

function installPageRealmBridge(globalObject = globalThis) {
  if (PAGE_REALM_STATES.has(globalObject)) return PAGE_REALM_STATES.get(globalObject);
  const documentObject = globalObject.document;
  const parent = documentObject?.documentElement || documentObject?.head || documentObject?.body;
  if (!parent || typeof documentObject.createElement !== "function" || typeof documentObject.dispatchEvent !== "function") {
    throw new OJMonitorError("source-unavailable", "当前页面尚不能安装主世界请求代理");
  }
  const channel = createId("page-realm").replace(/[^a-zA-Z0-9_-]/g, "");
  const events = {
    marker: `__OJMON_PAGE_REALM_${channel}`,
    ready: `ojmon:${channel}:ready`,
    request: `ojmon:${channel}:request`,
    response: `ojmon:${channel}:response`,
    cancel: `ojmon:${channel}:cancel`
  };
  let ready = false;
  const onReady = () => { ready = true; };
  documentObject.addEventListener(events.ready, onReady);
  const script = documentObject.createElement("script");
  script.textContent = `;(${installPageRealmEndpoint.toString()})(document, window, ${JSON.stringify(events)});`;
  parent.appendChild(script);
  script.remove?.();
  documentObject.removeEventListener(events.ready, onReady);
  if (!ready) {
    throw new OJMonitorError("source-unavailable", "页面主世界请求代理被 CSP 或用户脚本环境阻止");
  }
  const state = { document: documentObject, events };
  PAGE_REALM_STATES.set(globalObject, state);
  return state;
}

function pageRealmRequest(globalObject, url, options = {}) {
  const state = installPageRealmBridge(globalObject);
  const EventConstructor = globalObject.CustomEvent;
  if (typeof EventConstructor !== "function") {
    throw new OJMonitorError("source-unavailable", "当前页面缺少 CustomEvent，无法使用主世界请求代理");
  }
  const id = createId("page-request");
  const timeout = Number.isFinite(options.timeout) ? Math.max(1, options.timeout) : 30000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      state.document.removeEventListener(state.events.response, onResponse);
      options.signal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const dispatchCancel = () => state.document.dispatchEvent(new EventConstructor(state.events.cancel, {
      detail: JSON.stringify({ id })
    }));
    const onAbort = () => {
      dispatchCancel();
      settle(reject, new OJMonitorError("network-error", "页面主世界请求已取消"));
    };
    const onResponse = (event) => {
      let response;
      try {
        response = JSON.parse(String(event.detail || ""));
      } catch {
        return;
      }
      if (response.id !== id) return;
      if (!response.ok) {
        settle(reject, new OJMonitorError("network-error", response.message || "页面主世界请求失败"));
        return;
      }
      settle(resolve, {
        status: response.status,
        finalUrl: response.finalUrl || url,
        headers: new Map(response.headers || []),
        text: response.text ?? "",
        transport: "page-realm-fetch"
      });
    };
    state.document.addEventListener(state.events.response, onResponse);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      dispatchCancel();
      settle(reject, new OJMonitorError("network-error", "页面主世界请求超时"));
    }, timeout);
    state.document.dispatchEvent(new EventConstructor(state.events.request, {
      detail: JSON.stringify({
        id,
        url: String(url),
        method: options.method || "GET",
        headers: plainHeaders(options.headers)
      })
    }));
  });
}

function gmRequest(globalObject, options) {
  // Derived from OJBetter's GPL-3.0 OJB_GMRequest settle-once Promise wrapper.
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const { signal, ...transportOptions } = options;
    const requestOptions = {
      ...transportOptions,
      onload: (response) => settle(resolve, response),
      onerror: (error) => settle(reject, new OJMonitorError("network-error", "跨域请求失败", error)),
      ontimeout: (error) => settle(reject, new OJMonitorError("network-error", "请求超时", error)),
      onabort: (error) => settle(reject, new OJMonitorError("network-error", "请求已取消", error))
    };
    try {
      request = globalObject.GM_xmlhttpRequest(requestOptions);
    } catch (error) {
      settle(reject, error);
    }
    if (signal) {
      if (signal.aborted) {
        request?.abort?.();
        settle(reject, new OJMonitorError("network-error", "请求已取消"));
      } else signal.addEventListener("abort", () => request?.abort?.(), { once: true });
    }
  });
}

class HttpClient {
  constructor(options = {}) {
    this.global = options.globalObject || globalThis;
    this.transport = options.transport || null;
    this.siteBridge = options.siteBridge || null;
    this.beforeRequest = options.beforeRequest || null;
    this.timeout = options.timeout || 30000;
    this.onRetry = options.onRetry || null;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async request(url, options = {}) {
    const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 2;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(url, options);
      } catch (error) {
        if (error.status !== "network-error" || options.signal?.aborted || attempt >= retries) throw error;
        if (this.onRetry) await this.onRetry(url, attempt + 1, error);
        await this.sleep(Math.min(4000, 500 * (2 ** attempt)));
      }
    }
  }

  async requestOnce(url, options = {}) {
    if (this.beforeRequest) await this.beforeRequest(url, options);
    let response;
    try {
      if (this.transport) {
        response = await this.transport(url, options);
      } else if (options.transport === "site-bridge") {
        if (!this.siteBridge) throw new OJMonitorError("source-unavailable", "跨标签页请求代理尚未启动");
        response = await this.siteBridge.request(url, options);
      } else if (options.transport === "page-fetch") {
        if (!isSameOrigin(url, this.global.location)) {
          throw new OJMonitorError("source-unavailable", "页面请求只能访问当前标签页的同源地址");
        }
        try {
          response = await pageRealmRequest(this.global, url, { ...options, timeout: options.timeout || this.timeout });
        } catch (pageError) {
          if (pageError.status !== "source-unavailable") throw pageError;
          const binding = pageFetchBinding(this.global);
          if (!binding) throw pageError;
          const transfer = pageRealmFetchInit(this.global, binding, options);
          const fetchResponse = await Reflect.apply(binding.fetch, binding.owner, [url, transfer.value]);
          response = {
            status: fetchResponse.status,
            finalUrl: fetchResponse.url,
            headers: fetchResponse.headers,
            text: await fetchResponse.text(),
            transport: binding.name,
            transportFallback: {
              requested: "page-realm-fetch",
              status: pageError.status,
              reason: pageError.message,
              realmTransfer: transfer.mode
            }
          };
        }
      } else if (options.transport === "gm-xhr" && typeof this.global.GM_xmlhttpRequest === "function") {
        const gmResponse = await gmRequest(this.global, {
          method: options.method || "GET",
          url,
          headers: options.headers,
          data: options.body,
          redirect: options.redirect || "follow",
          ...gmCookiePartitionOptions(options),
          timeout: options.timeout || this.timeout,
          signal: options.signal,
          responseType: "text"
        });
        response = {
          status: gmResponse.status,
          finalUrl: gmResponse.finalUrl || url,
          headers: parseHeaderText(gmResponse.responseHeaders),
          text: gmResponse.responseText ?? gmResponse.response ?? "",
          transport: "gm-xhr"
        };
      } else if (isSameOrigin(url, this.global.location) && typeof this.global.fetch === "function") {
        const fetchResponse = await this.global.fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
          credentials: "include",
          signal: options.signal,
          redirect: options.redirect || "follow"
        });
        response = {
          status: fetchResponse.status,
          finalUrl: fetchResponse.url,
          headers: fetchResponse.headers,
          text: await fetchResponse.text(),
          transport: "same-origin-fetch"
        };
      } else if (typeof this.global.GM_xmlhttpRequest === "function") {
        const gmResponse = await gmRequest(this.global, {
          method: options.method || "GET",
          url,
          headers: options.headers,
          data: options.body,
          redirect: options.redirect || "follow",
          ...gmCookiePartitionOptions(options),
          timeout: options.timeout || this.timeout,
          signal: options.signal,
          responseType: "text"
        });
        response = {
          status: gmResponse.status,
          finalUrl: gmResponse.finalUrl || url,
          headers: parseHeaderText(gmResponse.responseHeaders),
          text: gmResponse.responseText ?? gmResponse.response ?? "",
          transport: "gm-xhr"
        };
      } else if (typeof this.global.fetch === "function") {
        const fetchResponse = await this.global.fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
          credentials: "include",
          signal: options.signal,
          redirect: options.redirect || "follow"
        });
        response = { status: fetchResponse.status, finalUrl: fetchResponse.url, headers: fetchResponse.headers, text: await fetchResponse.text(), transport: "fetch-fallback" };
      } else {
        throw new OJMonitorError("network-error", "没有可用的浏览器请求能力");
      }
    } catch (error) {
      if (error instanceof OJMonitorError) throw error;
      throw new OJMonitorError("network-error", "请求失败", { url, cause: error });
    }
    const error = classifyResponse(response, url);
    if (error) {
      error.details = {
        ...(error.details || {}),
        transport: response.transport,
        httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : undefined,
        transportFallback: response.transportFallback
      };
      throw error;
    }
    return response;
  }

  async json(url, options = {}) {
    const response = await this.request(url, options);
    try {
      return { data: JSON.parse(response.text), response };
    } catch (error) {
      throw new OJMonitorError("schema-changed", "响应不是有效 JSON", { url, cause: error, contentType: responseHeader(response, "content-type") });
    }
  }
}

module.exports = {
  HttpClient,
  classifyResponse,
  gmRequest,
  installPageRealmBridge,
  installPageRealmEndpoint,
  isSameOrigin,
  pageFetchBinding,
  pageRealmFetchInit,
  pageTransportCapability,
  pageTransportAvailable,
  pageRealmRequest,
  parseHeaderText,
  plainHeaders,
  gmCookiePartitionOptions,
  responseHeader
};

},
"src/adapters/nowcoder.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError } = __require("src/core.js");
const { failureResult, makeResult, validationFailure } = __require("src/adapters/common.js");

const BASE = "https://ac.nowcoder.com";
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = null;
const RATING_PATH = "/acm/contest/rating-index";
const USERNAME_MAX_LENGTH = 64;
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);|&apos;/gi, "'");
}

function stripHtml(value) {
  return decodeHtml(String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributeValue(openingTag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(openingTag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "");
}

function extractCells(rowHtml, tagName) {
  const expression = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  return [...String(rowHtml).matchAll(expression)].map((match) => match[1]);
}

function anchors(cellHtml) {
  return [...String(cellHtml).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: attributeValue(match[1], "href"),
    label: stripHtml(match[2])
  }));
}

function normalizeHeader(value) {
  return stripHtml(value).replace(/[\s_：:()（）-]+/g, "");
}

function headerKind(value) {
  const header = normalizeHeader(value);
  if (header === "运行ID") return "id";
  if (header === "题目") return "problem";
  if (header === "运行结果") return "result";
  if (header === "提交时间") return "submitTime";
  return undefined;
}

function assertUid(uid) {
  if (!/^[1-9]\d{0,17}$/.test(String(uid))) {
    throw new OJMonitorError("not-found", "牛客账号必须是 1 至 18 位正整数 UID");
  }
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim();
}

function foldedUsername(value) {
  return normalizeIdentifier(value).toLocaleLowerCase("en-US");
}

function assertUsername(username) {
  const value = normalizeIdentifier(username);
  if (!value || value.length > USERNAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OJMonitorError("not-found", `牛客竞赛用户名必须是 1 至 ${USERNAME_MAX_LENGTH} 个可见字符`);
  }
  return value;
}

function practicePath(uid) {
  return `/acm/contest/profile/${uid}/practice-coding`;
}

function parsePageIdentity(html) {
  return String(html).match(/window\.curUser\.id\s*=\s*["'](\d+)["']/i)?.[1] || "";
}

function parseDisplayName(html) {
  const source = String(html);
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/\bcoder-name\b/i.test(attributeValue(match[1], "class"))) continue;
    return attributeValue(match[1], "data-title") || stripHtml(match[2]) || undefined;
  }
  return undefined;
}

function assertRatingPage(response, identifier, requestedUrl) {
  const finalUrl = String(response?.finalUrl || requestedUrl || "");
  let parsed;
  try {
    parsed = new URL(finalUrl, BASE);
  } catch {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索返回了无效地址");
  }
  if (parsed.origin !== BASE || parsed.pathname.replace(/\/$/, "") !== RATING_PATH) {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索被重定向到未知页面", { finalUrl: parsed.href });
  }
  if (parsed.searchParams.get("searchUserName") !== identifier) {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索没有保留目标用户名", { finalUrl: parsed.href });
  }
  return parsed.href;
}

function assertPracticePage(response, uid, requestedUrl) {
  const finalUrl = String(response?.finalUrl || requestedUrl || "");
  let parsed;
  try {
    parsed = new URL(finalUrl, BASE);
  } catch {
    throw new OJMonitorError("schema-changed", "牛客练习页返回了无效地址");
  }
  const actualPath = parsed.pathname.replace(/\/$/, "") || "/";
  if (parsed.origin !== BASE || actualPath !== practicePath(uid)) {
    throw new OJMonitorError("not-found", "牛客 UID 不存在或练习页被重定向", { finalUrl: parsed.href });
  }
  const identity = parsePageIdentity(response?.text);
  if (!identity && /页面找不到了/.test(String(response?.text || ""))) {
    throw new OJMonitorError("not-found", "牛客 UID 不存在", { finalUrl: parsed.href });
  }
  if (!identity) throw new OJMonitorError("schema-changed", "牛客练习页缺少用户身份");
  if (identity !== String(uid)) {
    throw new OJMonitorError("schema-changed", `牛客练习页身份不匹配：期望 ${uid}，实际为 ${identity}`);
  }
  return { identity, displayName: parseDisplayName(response?.text), finalUrl: parsed.href };
}

// The public page renders a timezone-less wall-clock value. NowCoder does not
// expose an offset in this HTML contract, so the adapter explicitly assumes UTC+8.
function parseNowcoderTime(value) {
  const text = stripHtml(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
}

function isAcceptedNowcoderVerdict(value) {
  return stripHtml(value) === "答案正确";
}

function parseSubmissionTotal(html) {
  const source = String(html);
  const starts = [...source.matchAll(/<div\b[^>]*class=["'][^"']*\bmy-state-item\b[^"']*["'][^>]*>/gi)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index;
    const end = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    if (!/次提交/.test(stripHtml(block))) continue;
    const value = block.match(/<div\b[^>]*class=["'][^"']*\bstate-num\b[^"']*["'][^>]*>\s*(\d+)\s*<\/div>/i)?.[1];
    if (value !== undefined) return Number(value);
  }
  return null;
}

function ratingHeaderKind(value) {
  const header = normalizeHeader(value);
  if (header === "Rating排名") return "rank";
  if (header === "用户名") return "username";
  if (header === "Rating") return "rating";
  return undefined;
}

function parseNowcoderRatingHtml(html, identifier) {
  const source = String(html);
  const requested = assertUsername(identifier);
  const requiredColumns = ["rank", "username", "rating"];
  let rows;
  let columnIndex;
  for (const table of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const candidateRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
    for (const headerRow of candidateRows.filter((row) => /<th\b/i.test(row))) {
      const candidateIndex = {};
      extractCells(headerRow, "th").forEach((header, index) => {
        const kind = ratingHeaderKind(header);
        if (kind && candidateIndex[kind] === undefined) candidateIndex[kind] = index;
      });
      if (requiredColumns.every((required) => candidateIndex[required] !== undefined)) {
        rows = candidateRows;
        columnIndex = candidateIndex;
        break;
      }
    }
    if (rows) break;
  }
  if (!rows) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索缺少完整语义表头");

  const requiredCellCount = Math.max(...Object.values(columnIndex)) + 1;
  const candidates = [];
  for (const row of rows) {
    const cells = extractCells(row, "td");
    if (!cells.length || cells.length < requiredCellCount) continue;
    let sawProfileLink = false;
    for (const match of String(cells[columnIndex.username]).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      let candidate;
      try {
        candidate = new URL(attributeValue(match[1], "href"), BASE);
      } catch {
        continue;
      }
      const profile = candidate.pathname.match(/^\/acm\/contest\/profile\/(\d+)$/);
      if (candidate.origin !== BASE || !profile) continue;
      sawProfileLink = true;
      assertUid(profile[1]);
      const withoutControls = match[2].replace(/<button\b[\s\S]*?<\/button>/gi, " ");
      const canonicalName = stripHtml(withoutControls);
      if (!canonicalName) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索结果缺少规范用户名");
      candidates.push({ uid: profile[1], canonicalName });
    }
    if (!sawProfileLink) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索存在无法识别的用户行");
  }

  const matches = candidates.filter((candidate) => foldedUsername(candidate.canonicalName) === foldedUsername(requested));
  const unique = new Map(matches.map((candidate) => [candidate.uid, candidate]));
  if (!unique.size) throw new OJMonitorError("not-found", `牛客 Rating 搜索未找到竞赛用户名 ${requested}，请改填数字 UID`);
  if (unique.size > 1) throw new OJMonitorError("not-found", `牛客竞赛用户名 ${requested} 对应多个 UID，请改填数字 UID`);
  return [...unique.values()][0];
}

function parseNowcoderPracticeHtml(html, options = {}) {
  const source = String(html);
  const uid = String(options.uid || options.username || "");
  assertUid(uid);
  const identity = parsePageIdentity(source);
  if (!identity) {
    if (/页面找不到了/.test(source)) throw new OJMonitorError("not-found", "牛客 UID 不存在");
    throw new OJMonitorError("schema-changed", "牛客练习页缺少用户身份");
  }
  if (identity !== uid) throw new OJMonitorError("schema-changed", `牛客练习页身份不匹配：期望 ${uid}，实际为 ${identity}`);

  const requiredColumns = ["id", "problem", "result", "submitTime"];
  let rows;
  let columnIndex;
  for (const table of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const candidateRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
    for (const headerRow of candidateRows.filter((row) => /<th\b/i.test(row))) {
      const candidateIndex = {};
      extractCells(headerRow, "th").forEach((header, index) => {
        const kind = headerKind(header);
        if (kind && candidateIndex[kind] === undefined) candidateIndex[kind] = index;
      });
      if (requiredColumns.every((required) => candidateIndex[required] !== undefined)) {
        rows = candidateRows;
        columnIndex = candidateIndex;
        break;
      }
    }
    if (rows) break;
  }
  if (!rows) throw new OJMonitorError("schema-changed", "牛客练习页缺少完整语义表头");
  const requiredCellCount = Math.max(...Object.values(columnIndex)) + 1;

  const submissions = [];
  for (const row of rows) {
    const cells = extractCells(row, "td");
    if (!cells.length) continue;
    let submission;
    for (const link of anchors(cells[columnIndex.id] || "")) {
      try {
        const candidate = new URL(link.href, BASE);
        if (candidate.origin !== BASE || candidate.pathname !== "/acm/contest/view-submission") continue;
        const submissionId = candidate.searchParams.get("submissionId") || "";
        const rowUid = candidate.searchParams.get("uid") || "";
        if (!/^\d+$/.test(submissionId)) continue;
        if (rowUid && rowUid !== uid) throw new OJMonitorError("schema-changed", `牛客提交 ${submissionId} 的 UID 不匹配`);
        submission = { submissionId };
        break;
      } catch (error) {
        if (error instanceof OJMonitorError) throw error;
      }
    }
    if (!submission) {
      if (cells.length >= requiredCellCount) throw new OJMonitorError("schema-changed", "牛客练习页存在无法识别运行 ID 的提交行");
      continue;
    }

    let problem;
    for (const link of anchors(cells[columnIndex.problem] || "")) {
      try {
        const candidate = new URL(link.href, BASE);
        const match = candidate.pathname.match(/^\/acm\/problem\/(\d+)$/);
        if (candidate.origin !== BASE || !match) continue;
        problem = { id: match[1], name: link.label, url: candidate.href };
        break;
      } catch {
        // Ignore unrelated or malformed links and fail below if none is usable.
      }
    }
    if (!problem) throw new OJMonitorError("schema-changed", `牛客提交 ${submission.submissionId} 缺少可识别题目链接`);
    const submittedAt = parseNowcoderTime(cells[columnIndex.submitTime]);
    if (!Number.isFinite(submittedAt)) throw new OJMonitorError("schema-changed", `牛客提交 ${submission.submissionId} 的提交时间无法解析`);
    const verdict = stripHtml(cells[columnIndex.result]) || "UNKNOWN";
    submissions.push({
      groupId: options.groupId,
      accountId: options.accountId,
      judge: "nowcoder",
      scope: "default",
      username: options.recordUsername || uid,
      submissionId: submission.submissionId,
      problemKey: `nowcoder:${problem.id}`,
      problemName: problem.name || undefined,
      problemUrl: problem.url,
      submittedAt,
      verdict,
      accepted: isAcceptedNowcoderVerdict(verdict)
    });
  }

  const officialEmpty = /没有找到你想要的内容呢/.test(stripHtml(source));
  const submissionTotal = parseSubmissionTotal(source);
  if (!submissions.length && !officialEmpty && submissionTotal !== 0) {
    throw new OJMonitorError("schema-changed", "牛客练习页没有可解析提交，也没有可信空结果标记");
  }
  const currentPage = Number(options.page || 1);
  const totalText = source.match(/<ul\b[^>]*\bdata-total=["'](\d+)["']/i)?.[1];
  const totalPages = totalText === undefined ? null : Number(totalText);
  const decoded = decodeHtml(source);
  const hasNext = [...decoded.matchAll(/href=["']([^"']+)["']/gi)].some((match) => {
    try {
      const candidate = new URL(match[1], `${BASE}${practicePath(uid)}`);
      return candidate.pathname === practicePath(uid)
        && Number(candidate.searchParams.get("page")) === currentPage + 1;
    } catch {
      return false;
    }
  });
  return {
    submissions,
    hasNext,
    totalPages,
    explicitEmpty: !submissions.length && (officialEmpty || submissionTotal === 0),
    signature: submissions.map((item) => item.submissionId).join(","),
    displayName: parseDisplayName(source)
  };
}

class NowcoderAdapter {
  constructor(options) {
    this.id = "nowcoder";
    this.displayName = "牛客";
    this.client = options.client;
    this.limiter = options.limiter;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.clock = options.clock || (() => Date.now());
    this.resolutionCacheTtlMs = options.resolutionCacheTtlMs ?? RESOLUTION_CACHE_TTL_MS;
    this.resolutionCache = new Map();
  }

  ratingSearchUrl(identifier) {
    const query = new URLSearchParams({
      onlyMyFollow: "false",
      page: "1",
      pageSize: "50",
      searchUserName: identifier
    });
    return `${BASE}${RATING_PATH}?${query}`;
  }

  pageUrl(uid, page) {
    const query = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      search: "",
      statusTypeFilter: "-1",
      languageCategoryFilter: "-1",
      orderType: "DESC",
      page: String(page)
    });
    return `${BASE}${practicePath(uid)}?${query}`;
  }

  async requestPage(uid, page, signal) {
    const url = this.pageUrl(uid, page);
    await this.limiter?.waitTurn("ac.nowcoder.com", 1000);
    const response = await this.client.request(url, { signal });
    assertPracticePage(response, uid, url);
    return response;
  }

  async resolveUsername(identifier, signal) {
    const url = this.ratingSearchUrl(identifier);
    await this.limiter?.waitTurn("ac.nowcoder.com", 1000);
    const response = await this.client.request(url, { signal });
    assertRatingPage(response, identifier, url);
    return parseNowcoderRatingHtml(response.text, identifier);
  }

  async resolveIdentifier(value, options = {}) {
    const identifier = normalizeIdentifier(value);
    if (/^\d+$/.test(identifier)) {
      assertUid(identifier);
      return { uid: identifier, canonicalName: undefined, source: "uid" };
    }
    assertUsername(identifier);
    const key = foldedUsername(identifier);
    const cached = this.resolutionCache.get(key);
    const now = this.clock();
    if (cached && now - cached.at < this.resolutionCacheTtlMs) {
      return cached.value || cached.promise;
    }
    const promise = this.resolveUsername(identifier, options.signal);
    this.resolutionCache.set(key, { at: now, promise });
    try {
      const value = await promise;
      this.resolutionCache.set(key, { at: this.clock(), value });
      return value;
    } catch (error) {
      this.resolutionCache.delete(key);
      throw error;
    }
  }

  assertResolvedDisplay(resolution, displayName) {
    if (!resolution.canonicalName) return;
    if (!displayName || foldedUsername(displayName) !== foldedUsername(resolution.canonicalName)) {
      throw new OJMonitorError("schema-changed", "牛客 Rating 搜索结果与练习页用户名不匹配");
    }
  }

  async validateUser(username, options = {}) {
    try {
      const resolution = await this.resolveIdentifier(username, options);
      const response = await this.requestPage(resolution.uid, 1, options.signal);
      const parsed = parseNowcoderPracticeHtml(response.text, { uid: resolution.uid, username: resolution.uid, page: 1 });
      this.assertResolvedDisplay(resolution, parsed.displayName);
      return {
        exists: true,
        canonicalUsername: resolution.uid,
        displayName: parsed.displayName || resolution.canonicalName,
        status: "ok"
      };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async fetchSubmissions(options) {
    const submissions = [];
    const signatures = new Set();
    const seenIds = new Set();
    let pagesFetched = 0;
    let previousOldest = Infinity;
    let stopReason = "unknown";
    let resolution;
    let resultOptions = options;
    try {
      resolution = await this.resolveIdentifier(options.username, { signal: options.signal });
      const recordUsername = resolution.canonicalName || resolution.uid;
      resultOptions = { ...options, username: recordUsername };
      for (let page = 1; ; page += 1) {
        if (this.maxPages !== null && page > this.maxPages) {
          stopReason = "page-limit";
          break;
        }
        const response = await this.requestPage(resolution.uid, page, options.signal);
        const parsed = parseNowcoderPracticeHtml(response.text, {
          ...options,
          uid: resolution.uid,
          username: resolution.uid,
          recordUsername,
          page
        });
        this.assertResolvedDisplay(resolution, parsed.displayName);
        pagesFetched += 1;
        if (parsed.explicitEmpty) {
          stopReason = "empty-page";
          break;
        }
        if (signatures.has(parsed.signature)) {
          stopReason = "repeated-page";
          break;
        }
        signatures.add(parsed.signature);
        if (parsed.submissions.some((item) => seenIds.has(item.submissionId))) {
          stopReason = "overlapping-page";
          break;
        }

        let previous = Infinity;
        let newest = -Infinity;
        for (const submission of parsed.submissions) {
          if (submission.submittedAt > previous) throw new OJMonitorError("schema-changed", "牛客提交不再按时间倒序排列");
          previous = submission.submittedAt;
          newest = Math.max(newest, submission.submittedAt);
          seenIds.add(submission.submissionId);
          if (submission.submittedAt >= options.from && submission.submittedAt <= options.to) submissions.push(submission);
        }
        const oldest = Math.min(...parsed.submissions.map((item) => item.submittedAt));
        if (newest > previousOldest) throw new OJMonitorError("schema-changed", "牛客跨页提交时间回跳，无法证明分页完整");
        previousOldest = oldest;
        if (oldest < options.from) {
          stopReason = "reached-from";
          break;
        }
        if (parsed.totalPages !== null) {
          if (page > parsed.totalPages) throw new OJMonitorError("schema-changed", "牛客当前页超过页面声明的总页数");
          if (page >= parsed.totalPages) {
            stopReason = "last-page";
            break;
          }
          if (!parsed.hasNext) throw new OJMonitorError("schema-changed", "牛客分页声明仍有后页，但缺少下一页链接");
        } else if (!parsed.hasNext) {
          if (parsed.submissions.length >= PAGE_SIZE) {
            stopReason = "missing-pagination";
            break;
          }
          stopReason = "last-page";
          break;
        }
      }
      const complete = ["reached-from", "empty-page", "last-page"].includes(stopReason);
      const warnings = {
        "page-limit": `牛客分页达到配置的 ${this.maxPages} 页上限`,
        "repeated-page": "牛客返回重复分页，无法证明完整覆盖",
        "overlapping-page": "牛客相邻分页包含重复提交，无法证明完整覆盖",
        "missing-pagination": "牛客返回满页数据但缺少分页证据"
      };
      return makeResult(resultOptions, {
        judge: "nowcoder",
        scope: "default",
        status: complete ? "ok" : "partial",
        complete,
        submissions,
        reason: complete ? undefined : stopReason,
        warning: warnings[stopReason],
        diagnostics: { stopReason, pagesFetched, source: "nowcoder-practice-coding-html", resolvedUid: resolution.uid }
      });
    } catch (error) {
      return failureResult(resultOptions, "nowcoder", "default", error, {
        submissions,
        diagnostics: { stopReason: error.status || "request-error", pagesFetched, source: "nowcoder-practice-coding-html", resolvedUid: resolution?.uid }
      });
    }
  }
}

module.exports = {
  BASE,
  DEFAULT_MAX_PAGES,
  NowcoderAdapter,
  PAGE_SIZE,
  RESOLUTION_CACHE_TTL_MS,
  RATING_PATH,
  USERNAME_MAX_LENGTH,
  assertPracticePage,
  assertRatingPage,
  assertUid,
  foldedUsername,
  isAcceptedNowcoderVerdict,
  parseNowcoderPracticeHtml,
  parseNowcoderRatingHtml,
  parseNowcoderTime
};

},
"src/adapters/qoj.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError } = __require("src/core.js");
const { isSameOrigin, pageTransportAvailable } = __require("src/request.js");
const { failureResult, makeResult, validationFailure } = __require("src/adapters/common.js");

// Pages are time-ordered and are fetched until options.from is crossed.
// A page limit is only used when explicitly injected for testing/diagnostics.
const DEFAULT_MAX_PAGES = null;

function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

function stripHtml(value) {
  return decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractCells(rowHtml, tagName) {
  const cells = [];
  const expression = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = expression.exec(rowHtml))) cells.push(match[1]);
  return cells;
}

function normalizeHeader(value) {
  return stripHtml(value).toLowerCase().replace(/[\s_：:()（）-]+/g, "");
}

function headerKind(value) {
  const header = normalizeHeader(value);
  if (header === "id" || header === "编号" || header === "提交编号") return "id";
  if (["problem", "题目", "问题"].includes(header)) return "problem";
  if (["result", "verdict", "结果", "评测结果"].includes(header)) return "result";
  if (["submitter", "username", "提交者", "用户名"].includes(header)) return "submitter";
  if (["submittime", "submissiontime", "提交时间"].includes(header)) return "submitTime";
  return undefined;
}

function parseQojTime(value) {
  const text = stripHtml(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
}

function isAcceptedQojVerdict(value) {
  const verdict = stripHtml(value).trim();
  if (/^(?:AC|Accepted)(?:!|\s*[✓✔√])?$/i.test(verdict)) return true;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(verdict)) return Number(verdict) === 100;
  return false;
}

function parseHref(cellHtml, expression) {
  const linkExpression = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let link;
  while ((link = linkExpression.exec(cellHtml))) {
    const href = decodeHtml(link[1]);
    const match = href.match(expression);
    if (match) return { href, match, label: stripHtml(link[2]) };
  }
  return null;
}

function attributeValue(tagHtml, name) {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = String(tagHtml).match(expression);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function classText(html, className) {
  const source = String(html);
  const openingTag = /<([a-z][\w:-]*)\b[^>]*>/gi;
  let opening;
  while ((opening = openingTag.exec(source))) {
    const classes = attributeValue(opening[0], "class");
    if (!classes || !classes.split(/\s+/).includes(className)) continue;
    const closingTag = new RegExp(`<\\/${opening[1]}\\s*>`, "i");
    const closing = source.slice(openingTag.lastIndex).match(closingTag);
    if (!closing) continue;
    return stripHtml(source.slice(openingTag.lastIndex, openingTag.lastIndex + closing.index));
  }
  return "";
}

function normalizeSubmitterLabel(value) {
  return stripHtml(value).replace(/\s+#\s*$/, "").trim();
}

function parseQojSubmitter(cellHtml) {
  const semantic = normalizeSubmitterLabel(classText(cellHtml, "uoj-username"));
  if (semantic) return semantic;
  const profileLink = parseHref(cellHtml, /\/user\/profile\/([^/?#]+)(?:[/?#]|$)/i);
  if (profileLink) {
    const label = normalizeSubmitterLabel(profileLink.label);
    if (label) return label;
    try {
      return decodeURIComponent(profileLink.match[1]);
    } catch {
      return profileLink.match[1];
    }
  }
  return normalizeSubmitterLabel(cellHtml);
}

function isQojEmptySubmissionPage(source, options = {}) {
  if (/href=["'][^"']*\/submission\/\d+(?:[/?#"'])/i.test(source)) return false;
  const expected = String(options.username || "").toLowerCase();
  if (!expected) return false;

  let matchingFilter = false;
  const formExpression = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let form;
  while ((form = formExpression.exec(source))) {
    const opening = form[0].match(/^<form\b[^>]*>/i)?.[0] || "";
    const action = attributeValue(opening, "action");
    if (!action) continue;
    try {
      if (new URL(action, options.base || "https://qoj.ac").pathname !== "/submissions") continue;
    } catch {
      continue;
    }
    const inputs = form[0].match(/<input\b[^>]*>/gi) || [];
    matchingFilter = inputs.some((input) =>
      String(attributeValue(input, "name") || "").toLowerCase() === "submitter"
      && String(attributeValue(input, "value") || "").toLowerCase() === expected
    );
    if (matchingFilter) break;
  }
  if (!matchingFilter) return false;

  const text = stripHtml(source);
  const explicitEmpty = /(?:\bno\s+submissions?(?:\s+found)?\b|\bnothing\s+found\b|\bno\s+records?(?:\s+found)?\b|暂无(?:任何)?提交|没有(?:任何)?提交(?:记录)?|无提交记录)/i.test(text);
  const submissionsTitle = /<title\b[^>]*>[\s\S]*?submissions?[\s\S]*?<\/title>/i.test(source);
  return explicitEmpty || submissionsTitle;
}

function parseQojSubmissionsHtml(html, options = {}) {
  const source = String(html);
  if (/<form\b[^>]*(?:action=["']\/login|id=["']form-login)/i.test(source) || /href=["']\/login["'][^>]*>\s*(?:login|登录)/i.test(source) && !/<table\b/i.test(source)) {
    throw new OJMonitorError("login-required", "请先登录 QOJ");
  }
  const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const headerRow = rows.find((row) => /<th\b/i.test(row));
  if (!headerRow && isQojEmptySubmissionPage(source, options)) {
    return { submissions: [], hasNext: false, signature: "" };
  }
  if (!headerRow) throw new OJMonitorError("schema-changed", "QOJ 提交页缺少表头");
  const headers = extractCells(headerRow, "th");
  const columnIndex = {};
  headers.forEach((header, index) => {
    const kind = headerKind(header);
    if (kind && columnIndex[kind] === undefined) columnIndex[kind] = index;
  });
  for (const required of ["id", "problem", "submitter", "result", "submitTime"]) {
    if (columnIndex[required] === undefined) throw new OJMonitorError("schema-changed", `QOJ 提交页缺少 ${required} 列`);
  }

  const submissions = [];
  for (const row of rows) {
    const cells = extractCells(row, "td");
    if (!cells.length) continue;
    const idLink = parseHref(cells[columnIndex.id] || "", /\/submission\/(\d+)(?:[/?#]|$)/i);
    if (!idLink) continue;
    const problemLink = parseHref(cells[columnIndex.problem] || "", /\/(?:contest\/\d+\/)?problem\/(\d+)(?:[/?#]|$)/i);
    if (!problemLink) throw new OJMonitorError("schema-changed", `QOJ submission ${idLink.match[1]} 缺少可识别题目链接`);
    const submittedAt = parseQojTime(cells[columnIndex.submitTime]);
    if (!Number.isFinite(submittedAt)) throw new OJMonitorError("schema-changed", `QOJ submission ${idLink.match[1]} 的提交时间无法解析`);
    const verdict = stripHtml(cells[columnIndex.result]);
    const submitter = parseQojSubmitter(cells[columnIndex.submitter]);
    if (options.username && submitter.toLowerCase() !== String(options.username).toLowerCase()) {
      throw new OJMonitorError("schema-changed", `QOJ 提交者筛选未生效：期望 ${options.username}，实际为 ${submitter || "空"}`);
    }
    const problemId = problemLink.match[1];
    const problemUrl = new URL(problemLink.href, options.base || "https://qoj.ac");
    if (!/^https?:$/.test(problemUrl.protocol)) throw new OJMonitorError("schema-changed", `QOJ submission ${idLink.match[1]} 的题目链接协议无效`);
    submissions.push({
      groupId: options.groupId,
      accountId: options.accountId,
      judge: "qoj",
      scope: "default",
      username: options.username,
      submissionId: idLink.match[1],
      problemKey: `qoj:${problemId}`,
      problemName: problemLink.label.replace(/^#?\d+\.?\s*/, "") || undefined,
      problemUrl: problemUrl.href,
      submittedAt,
      verdict: verdict || "UNKNOWN",
      accepted: isAcceptedQojVerdict(verdict)
    });
  }

  const currentPage = Number(options.page || 1);
  const decoded = decodeHtml(source);
  const hasNext = [...decoded.matchAll(/href=["']([^"']+)["']/gi)].some((match) => {
    try {
      const candidate = new URL(match[1], options.base || "https://qoj.ac");
      return candidate.pathname === "/submissions" && Number(candidate.searchParams.get("page")) === currentPage + 1;
    } catch {
      return false;
    }
  });
  return { submissions, hasNext, signature: submissions.map((item) => item.submissionId).join(",") };
}

function qojFailureWarning(error) {
  if (["login-required", "verification-required"].includes(error?.status)) {
    return "已尝试页面会话、油猴请求和跨标签页代理，但 QOJ 仍返回登录/Cloudflare 验证页；请刷新已验证的 QOJ 标签页后重试";
  }
  return error instanceof Error ? error.message : String(error || "QOJ 获取失败");
}

class QojAdapter {
  constructor(options) {
    this.id = "qoj";
    this.displayName = "QOJ";
    this.client = options.client;
    this.limiter = options.limiter;
    this.maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES;
  }

  isQojPage() {
    return String(this.client.global?.location?.hostname || "").toLowerCase() === "qoj.ac";
  }

  siteBase() {
    return this.isQojPage() ? this.client.global.location.origin : "https://qoj.ac";
  }

  assertUsername(username) {
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(String(username))) {
      throw new OJMonitorError("not-found", "QOJ 用户名只能包含 1–50 位字母、数字、下划线或连字符");
    }
  }

  async requestPage(url, requestOptions, transform = (response) => response) {
    const sameOrigin = isSameOrigin(url, this.client.global?.location);
    const hasPageTransport = sameOrigin && pageTransportAvailable(this.client.global);
    const hasGmTransport = typeof this.client.global?.GM_xmlhttpRequest === "function";
    const hasSiteBridge = Boolean(this.client.siteBridge);
    const transports = [
      ...(hasPageTransport ? ["page-fetch"] : []),
      ...(hasGmTransport ? ["gm-xhr"] : []),
      ...(!sameOrigin && hasSiteBridge ? ["site-bridge"] : []),
      ...(sameOrigin || (!hasGmTransport && !hasSiteBridge) ? [undefined] : [])
    ];
    const attemptedTransports = [];
    for (let index = 0; index < transports.length; index += 1) {
      const transport = transports[index];
      const transportName = transport || "auto";
      attemptedTransports.push(transportName);
      try {
        const response = await this.client.request(url, { ...requestOptions, ...(transport ? { transport } : {}) });
        return {
          value: transform(response),
          response,
          transport: response.transport || transportName,
          attemptedTransports
        };
      } catch (error) {
        const canFallback = index < transports.length - 1 && [
          "login-required", "verification-required", "source-unavailable", "network-error"
        ].includes(error?.status);
        if (canFallback) continue;
        if (error && typeof error === "object") {
          error.details = { ...(error.details || {}), transport: transportName, attemptedTransports: [...attemptedTransports] };
        }
        throw error;
      }
    }
    throw new OJMonitorError("network-error", "QOJ 请求没有可用传输方式", { attemptedTransports });
  }

  async validateUser(username, options = {}) {
    try {
      this.assertUsername(username);
      await this.limiter?.waitTurn("qoj.ac", 750);
      const page = await this.requestPage(`${this.siteBase()}/user/profile/${encodeURIComponent(username)}`, { signal: options.signal }, (response) => {
        if (/<form\b[^>]*(?:action=["']\/login|id=["']form-login)/i.test(response.text)) {
          throw new OJMonitorError("login-required", "请先登录 QOJ");
        }
        return response;
      });
      return {
        exists: true,
        canonicalUsername: username,
        status: "ok",
        transport: page.transport,
        attemptedTransports: page.attemptedTransports
      };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return { ...validationFailure(error), details: error?.details };
    }
  }

  async fetchSubmissions(options) {
    const submissions = [];
    const signatures = new Set();
    let stopReason = "unknown";
    let pagesFetched = 0;
    let previousOldest = Infinity;
    let transportUsed;
    let attemptedTransports;
    try {
      const validation = await this.validateUser(options.username, { signal: options.signal });
      if (validation.exists === false) throw new OJMonitorError("not-found", validation.message || "QOJ 用户不存在");
      if (validation.exists !== true) throw new OJMonitorError(validation.status, validation.message || "无法验证 QOJ 用户", validation.details);
      transportUsed = validation.transport;
      attemptedTransports = validation.attemptedTransports;
      for (let page = 1; ; page += 1) {
        if (this.maxPages !== null && page > this.maxPages) {
          stopReason = "page-limit";
          break;
        }
        await this.limiter?.waitTurn("qoj.ac", 750);
        const query = new URLSearchParams({ submitter: options.username, page: String(page) });
        const pageResponse = await this.requestPage(`${this.siteBase()}/submissions?${query}`, { signal: options.signal }, (response) =>
          parseQojSubmissionsHtml(response.text, { ...options, page, base: this.siteBase() })
        );
        const parsed = pageResponse.value;
        transportUsed = pageResponse.transport;
        attemptedTransports = pageResponse.attemptedTransports;
        pagesFetched += 1;
        if (!parsed.submissions.length) {
          stopReason = "empty-page";
          break;
        }
        if (signatures.has(parsed.signature)) {
          stopReason = "repeated-page";
          break;
        }
        signatures.add(parsed.signature);
        let previous = Infinity;
        let newest = -Infinity;
        for (const submission of parsed.submissions) {
          if (submission.submittedAt > previous) throw new OJMonitorError("schema-changed", "QOJ 提交不再按时间倒序排列");
          previous = submission.submittedAt;
          newest = Math.max(newest, submission.submittedAt);
          if (submission.submittedAt >= options.from && submission.submittedAt <= options.to) submissions.push(submission);
        }
        const oldest = Math.min(...parsed.submissions.map((item) => item.submittedAt));
        if (newest > previousOldest) throw new OJMonitorError("schema-changed", "QOJ 跨页提交顺序异常，不能证明分页完整");
        previousOldest = oldest;
        if (oldest < options.from) {
          stopReason = "reached-from";
          break;
        }
        if (!parsed.hasNext) {
          stopReason = "last-page";
          break;
        }
      }
      const complete = !["page-limit", "repeated-page", "unknown"].includes(stopReason);
      const warning = stopReason === "page-limit"
        ? `QOJ 分页达到配置的 ${this.maxPages} 页上限`
        : stopReason === "repeated-page" ? "QOJ 返回重复分页，无法证明完整覆盖" : undefined;
      return makeResult(options, {
        judge: "qoj",
        scope: "default",
        status: complete ? "ok" : "partial",
        complete,
        submissions,
        reason: complete ? undefined : stopReason,
        warning,
        diagnostics: { stopReason, pagesFetched, source: "qoj-submissions-html", sameOrigin: this.isQojPage(), transport: transportUsed, attemptedTransports }
      });
    } catch (error) {
      return failureResult(options, "qoj", "default", error, {
        submissions,
        warning: qojFailureWarning(error),
        diagnostics: {
          stopReason: error.status || "request-error",
          pagesFetched,
          source: "qoj-submissions-html",
          sameOrigin: this.isQojPage(),
          transport: transportUsed || error.details?.transport,
          attemptedTransports: attemptedTransports || error.details?.attemptedTransports
        }
      });
    }
  }
}

module.exports = {
  QojAdapter,
  DEFAULT_MAX_PAGES,
  decodeHtml,
  headerKind,
  isAcceptedQojVerdict,
  parseQojSubmissionsHtml,
  parseQojSubmitter,
  parseQojTime,
  qojFailureWarning,
  stripHtml
};

},
"src/adapters/vjudge.js": function(module, exports, __require) {
"use strict";

const { OJMonitorError } = __require("src/core.js");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = __require("src/adapters/common.js");

const RESULT_FILTERS = Object.freeze([
  "AC", "PE", "WA", "TLE", "MLE", "OLE", "RE", "CE",
  "JUDGE_FAILED", "SUBMIT_FAILED_PERM", "SUBMIT_FAILED_TEMP", "PENDING"
]);

function normalizeVJudgeSubmission(record, options) {
  const runId = requireText(record?.runId, "VJudge runId");
  const origin = requireText(record?.oj, "VJudge oj");
  const originProblem = requireText(record?.probNum ?? record?.problemId, "VJudge probNum/problemId");
  const time = requireFinite(record?.time, "VJudge time(ms)");
  const statusType = requireFinite(record?.statusType, "VJudge statusType");
  if (typeof record.processing !== "boolean") throw new OJMonitorError("schema-changed", "VJudge processing 不是布尔值");
  const verdict = record.processing ? "Pending" : typeof record.status === "string" ? record.status : `statusType:${statusType}`;
  return {
    groupId: options.groupId,
    accountId: options.accountId,
    judge: "vjudge",
    scope: "default",
    username: options.username,
    submissionId: runId,
    problemKey: `vjudge:${origin}:${originProblem}`,
    problemName: `${origin} ${originProblem}`,
    problemUrl: `https://vjudge.net/problem/${encodeURIComponent(origin)}-${encodeURIComponent(originProblem)}`,
    submittedAt: time,
    verdict,
    accepted: record.processing === false && statusType === 0
  };
}

class VJudgeAdapter {
  constructor(options) {
    this.id = "vjudge";
    this.displayName = "VJudge";
    this.client = options.client;
    this.limiter = options.limiter;
  }

  async validateUser(username, options = {}) {
    try {
      await this.client.request(`https://vjudge.net/user/${encodeURIComponent(username)}`, { signal: options.signal });
      return { exists: true, canonicalUsername: username, status: "ok" };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async fetchPage(options, start, resultFilter = "all") {
    await this.limiter?.waitTurn("vjudge.net", 500);
    const query = new URLSearchParams({
      draw: "1",
      start: String(start),
      length: "100",
      un: options.username,
      OJId: "All",
      probNum: "",
      res: resultFilter,
      language: ""
    });
    const { data } = await this.client.json(`https://vjudge.net/status/data?${query}`, { signal: options.signal });
    return requireArray(data?.data, "VJudge status.data");
  }

  async fetchSlice(options, resultFilter = "all") {
    const records = [];
    for (const start of [0, 100]) {
      const page = await this.fetchPage(options, start, resultFilter);
      records.push(...page);
      if (page.length < 100) break;
      const oldest = Math.min(...page.map((record) => requireFinite(record?.time, "VJudge time")));
      if (oldest < options.from) break;
    }
    const relevant = records.filter((record) => Number(record.time) >= options.from && Number(record.time) <= options.to);
    const oldest = records.length ? Math.min(...records.map((record) => Number(record.time))) : Infinity;
    const complete = records.length < 200 || oldest < options.from;
    return { records: relevant, complete, totalFetched: records.length };
  }

  async fetchSubmissions(options) {
    const byId = new Map();
    try {
      const base = await this.fetchSlice(options);
      let complete = base.complete;
      let sliced = false;
      let truncatedFilters = [];
      const consume = (records) => {
        for (const record of records) {
          const normalized = normalizeVJudgeSubmission(record, options);
          byId.set(normalized.submissionId, normalized);
        }
      };
      consume(base.records);
      if (!base.complete) {
        sliced = true;
        complete = true;
        for (const filter of RESULT_FILTERS) {
          const slice = await this.fetchSlice(options, filter);
          consume(slice.records);
          if (!slice.complete) {
            complete = false;
            truncatedFilters.push(filter);
          }
        }
      }
      return makeResult(options, {
        judge: "vjudge",
        scope: "default",
        status: complete ? "ok" : "partial",
        complete,
        submissions: [...byId.values()],
        reason: complete ? undefined : "single-filter-window-limit",
        warning: complete ? undefined : "VJudge 仅取得部分记录（单查询窗口上限 200）",
        diagnostics: { stopReason: complete ? (sliced ? "exhaustive-result-slices" : "base-window-covered") : "slice-truncated", sliced, truncatedFilters }
      });
    } catch (error) {
      return failureResult(options, "vjudge", "default", error, {
        submissions: [...byId.values()],
        diagnostics: { stopReason: "request-error" }
      });
    }
  }
}

module.exports = { RESULT_FILTERS, VJudgeAdapter, normalizeVJudgeSubmission };

},
"src/app.js": function(module, exports, __require) {
"use strict";

const { createAdapters } = __require("src/adapters/index.js");
const { OJMonitorError } = __require("src/core.js");
const { HttpClient } = __require("src/request.js");
const { DomainRateLimiter, LeaseCoordinator } = __require("src/scheduler.js");
const { Diagnostics, MonitorService } = __require("src/service.js");
const { SiteSessionBridge } = __require("src/site-bridge.js");
const { GMBackend, Store } = __require("src/storage.js");
const { MonitorPanel } = __require("src/ui.js");

class OJMonitorApplication {
  constructor(globalObject = globalThis) {
    this.global = globalObject;
    this.store = new Store(new GMBackend(globalObject));
    this.limiter = new DomainRateLimiter(this.store);
    this.lease = new LeaseCoordinator(this.store);
    this.siteBridge = new SiteSessionBridge({ store: this.store, globalObject });
    this.client = new HttpClient({
      globalObject,
      siteBridge: this.siteBridge,
      onRetry: async (url) => {
        const hostname = new URL(url, globalObject.location?.href).hostname;
        const intervals = { "codeforces.com": 2000, "kenkoooo.com": 1000, "atcoder.jp": 500, "vjudge.net": 500, "www.luogu.com.cn": 500, "luogu.com.cn": 500, "ac.nowcoder.com": 1000, "qoj.ac": 750 };
        await this.limiter.waitTurn(hostname, intervals[hostname] || 500);
      }
    });
    this.siteBridge.client = this.client;
    this.diagnostics = new Diagnostics();
    this.adapters = createAdapters({ client: this.client, store: this.store, limiter: this.limiter });
    this.service = new MonitorService({ store: this.store, adapters: this.adapters, diagnostics: this.diagnostics });
    this.abortController = null;
    this.panel = null;
  }

  async start() {
    await this.siteBridge.start();
    const config = await this.store.loadConfig();
    this.panel = new MonitorPanel({
      globalObject: this.global,
      store: this.store,
      service: this.service,
      config,
      onRefresh: (onProgress) => this.refresh(onProgress),
      onCancel: () => this.cancelRefresh()
    });
    this.panel.mount();
    return this;
  }

  async refresh(onProgress) {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const config = await this.store.loadConfig();
    const previousRefresh = await this.store.get("last-refresh", null);
    const previousRefreshAt = Number(previousRefresh?.at || 0);
    const ttl = 120000;
    try {
      for (;;) {
        if (controller.signal.aborted) throw new OJMonitorError("network-error", "获取已取消");
        const response = await this.lease.runExclusive("global-refresh", async () => {
          const value = await this.service.refresh(config, { signal: controller.signal, onProgress });
          if (controller.signal.aborted) throw new OJMonitorError("network-error", "获取已取消");
          return value;
        }, { ttl, attempts: 1 });
        if (response.acquired) return response;

        onProgress?.({ type: "lease-wait" });
        const outcome = await this.lease.waitForRelease("global-refresh", {
          signal: controller.signal,
          timeout: 30 * 60 * 1000,
          pollInterval: 1000,
          isComplete: async () => {
            const latest = await this.store.get("last-refresh", null);
            return Number(latest?.at || 0) > previousRefreshAt ? latest : false;
          }
        });
        if (outcome.reason === "completed") {
          onProgress?.({ type: "shared-complete", lastRefresh: outcome.value });
          return { acquired: false, shared: true, value: outcome.value };
        }
        if (outcome.reason === "available") {
          onProgress?.({ type: "lease-takeover" });
          continue;
        }
        throw new OJMonitorError("network-error", "等待另一个标签页获取超时，请关闭无响应的 OJ 标签页后重试");
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  cancelRefresh() {
    this.abortController?.abort();
  }
}

module.exports = { OJMonitorApplication };

},
"src/scheduler.js": function(module, exports, __require) {
"use strict";

const { createId, OJMonitorError } = __require("src/core.js");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

class LeaseCoordinator {
  constructor(store, options = {}) {
    this.store = store;
    this.ownerId = options.ownerId || createId("tab");
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || delay;
    this.random = options.random || Math.random;
  }

  leaseName(name) {
    return `lease:${name}`;
  }

  async acquire(name, options = {}) {
    const ttl = options.ttl || 30000;
    const attempts = options.attempts || 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const now = this.clock();
      const current = await this.store.get(this.leaseName(name), null);
      if (current && current.expiresAt > now && current.ownerId !== this.ownerId) {
        await this.sleep(Math.min(250 + Math.floor(this.random() * 500), Math.max(1, current.expiresAt - now)));
        continue;
      }
      const lease = {
        ownerId: this.ownerId,
        generation: Number(current?.generation || 0) + 1,
        expiresAt: now + ttl
      };
      await this.store.setAtomic(this.leaseName(name), lease);
      await this.sleep(Math.floor(this.random() * 25));
      const confirmed = await this.store.get(this.leaseName(name), null);
      if (confirmed?.ownerId === lease.ownerId && confirmed?.generation === lease.generation) return lease;
    }
    return null;
  }

  async renew(name, lease, ttl = 30000) {
    const current = await this.store.get(this.leaseName(name), null);
    if (!current || current.ownerId !== lease.ownerId || current.generation !== lease.generation) return false;
    const renewed = { ...current, expiresAt: this.clock() + ttl };
    await this.store.setAtomic(this.leaseName(name), renewed);
    const confirmed = await this.store.get(this.leaseName(name), null);
    if (confirmed?.ownerId === renewed.ownerId && confirmed?.generation === renewed.generation) {
      Object.assign(lease, renewed);
      return true;
    }
    return false;
  }

  async release(name, lease) {
    const current = await this.store.get(this.leaseName(name), null);
    if (current?.ownerId === lease.ownerId && current?.generation === lease.generation) {
      await this.store.delete(this.leaseName(name));
      return true;
    }
    return false;
  }

  async waitForRelease(name, options = {}) {
    const timeout = Number.isFinite(options.timeout) ? Math.max(1, options.timeout) : 30 * 60 * 1000;
    const pollInterval = Number.isFinite(options.pollInterval) ? Math.max(1, options.pollInterval) : 1000;
    const deadline = this.clock() + timeout;
    for (;;) {
      if (options.signal?.aborted) throw new OJMonitorError("network-error", "等待共享获取已取消");
      const completed = await options.isComplete?.();
      if (completed) return { reason: "completed", value: completed === true ? undefined : completed };
      const now = this.clock();
      const current = await this.store.get(this.leaseName(name), null);
      if (!current || current.expiresAt <= now || current.ownerId === this.ownerId) {
        return { reason: "available", lease: current };
      }
      if (now >= deadline) return { reason: "timeout", lease: current };
      await this.sleep(Math.min(pollInterval, Math.max(1, current.expiresAt - now), Math.max(1, deadline - now)));
    }
  }

  async runExclusive(name, task, options = {}) {
    const lease = await this.acquire(name, options);
    if (!lease) return { acquired: false, value: undefined };
    const ttl = options.ttl || 30000;
    const heartbeat = setInterval(() => {
      this.renew(name, lease, ttl).catch(() => undefined);
    }, Math.max(1000, Math.floor(ttl / 3)));
    try {
      return { acquired: true, value: await task(lease) };
    } finally {
      clearInterval(heartbeat);
      await this.release(name, lease);
    }
  }
}

class DomainRateLimiter {
  constructor(store, options = {}) {
    this.store = store;
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || delay;
    this.chains = new Map();
  }

  async waitTurn(domain, minimumInterval) {
    const previous = this.chains.get(domain) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.chains.set(domain, tail);
    await previous;
    try {
      const key = `rate:${domain}`;
      const nextAllowedAt = Number(await this.store.get(key, 0));
      const wait = nextAllowedAt - this.clock();
      if (wait > 0) await this.sleep(wait);
      const reserved = this.clock() + minimumInterval;
      await this.store.setAtomic(key, reserved);
      return reserved;
    } finally {
      release();
      if (this.chains.get(domain) === tail) this.chains.delete(domain);
    }
  }

  async coolDown(domain, milliseconds) {
    const key = `rate:${domain}`;
    const current = Number(await this.store.get(key, 0));
    await this.store.setAtomic(key, Math.max(current, this.clock() + milliseconds));
  }
}

module.exports = { DomainRateLimiter, LeaseCoordinator, delay };

},
"src/service.js": function(module, exports, __require) {
"use strict";

const { aggregateDaily, mergeSubmissions, recentDateKeys } = __require("src/core.js");
const { failureResult } = __require("src/adapters/common.js");

function sourceIdentity(result) {
  return [result.groupId, result.accountId, result.judge, result.scope].join(":");
}

function firstDateEpoch(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (timeZone === "Asia/Shanghai") return Date.parse(`${dateKey}T00:00:00+08:00`);
  return new Date(year, month - 1, day).getTime();
}

function windowBounds(settings, now = Date.now()) {
  const dateKeys = recentDateKeys(settings.days, now, settings.timeZone);
  return { dateKeys, from: firstDateEpoch(dateKeys[0], settings.timeZone), to: now };
}

class Diagnostics {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  add(entry) {
    this.entries.push({ at: Date.now(), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  export() {
    return JSON.stringify({ generatedAt: Date.now(), entries: this.entries }, null, 2);
  }
}

class MonitorService {
  constructor(options) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.diagnostics = options.diagnostics || new Diagnostics();
    this.clock = options.clock || (() => Date.now());
  }

  async validateAccount(account, signal) {
    const adapter = this.adapters[account.judge];
    if (!adapter) return { exists: null, status: "source-unavailable", message: "未知 OJ" };
    return adapter.validateUser(account.username, { signal });
  }

  async fetchAccount(group, account, bounds, signal, onProgress) {
    const selectedScopes = account.judge === "codeforces"
      ? ["problemset", "gym"].filter((scope) => account.scopes?.[scope] !== false)
      : ["default"];
    const previousStates = await Promise.all(selectedScopes.map((scope) =>
      this.store.loadSourceState([group.id, account.id, account.judge, scope].join(":"))
    ));
    const canIncrement = previousStates.length > 0 && previousStates.every((state) =>
      state?.coverage?.complete === true && state.coverage.from <= bounds.from && Number.isFinite(state.coverage.to)
    );
    const previousTo = canIncrement ? Math.min(...previousStates.map((state) => state.coverage.to)) : bounds.from;
    const queryFrom = canIncrement ? Math.max(bounds.from, previousTo - 86400000) : bounds.from;
    const base = {
      groupId: group.id,
      accountId: account.id,
      username: account.username,
      from: queryFrom,
      to: bounds.to,
      signal
    };
    const adapter = this.adapters[account.judge];
    onProgress?.({ type: "source-start", group, account });
    const startedAt = this.clock();
    let results;
    if (account.judge === "codeforces") {
      const both = await adapter.fetchBoth(base);
      results = [];
      if (account.scopes?.problemset !== false) results.push(both.problemset);
      if (account.scopes?.gym !== false) {
        let gym = both.gym;
        if (gym.status === "ok" && adapter.canUseVisibleGymSupplement?.()) {
          const contestKinds = await adapter.getContestKinds(signal);
          const supplement = await adapter.fetchVisibleGymSupplement({ ...base, scope: "gym" }, contestKinds);
          if (supplement.submissions.length) {
            gym = {
              ...gym,
              status: "partial",
              submissions: mergeSubmissions(gym.submissions, supplement.submissions),
              warning: supplement.warning,
              coverage: { ...gym.coverage, complete: false, reason: supplement.coverage.reason },
              diagnostics: { ...gym.diagnostics, supplement: supplement.diagnostics }
            };
          }
        }
        results.push(gym);
      }
    } else {
      results = [await adapter.fetchSubmissions({ ...base, scope: "default" })];
    }
    for (const result of results) {
      if (canIncrement && result.coverage.complete) {
        result.coverage.from = bounds.from;
        result.diagnostics = { ...result.diagnostics, incrementalFrom: queryFrom };
      }
      this.diagnostics.add({
        judge: result.judge,
        scope: result.scope,
        groupId: group.id,
        accountId: account.id,
        durationMs: this.clock() - startedAt,
        status: result.status,
        recordCount: result.submissions.length,
        stopReason: result.diagnostics?.stopReason,
        pageOrigin: result.diagnostics?.pageOrigin,
        transport: result.diagnostics?.transport,
        attemptedTransports: result.diagnostics?.attemptedTransports,
        transportAttempts: result.diagnostics?.transportAttempts
      });
      onProgress?.({ type: "source-complete", group, account, result });
    }
    return results;
  }

  async refresh(config, options = {}) {
    const now = this.clock();
    const bounds = windowBounds(config.settings, now);
    const work = [];
    for (const group of config.groups) {
      for (const account of group.accounts) {
        const hasScope = account.judge !== "codeforces" || account.scopes?.problemset !== false || account.scopes?.gym !== false;
        if (account.enabled && account.username && hasScope) work.push({ group, account });
      }
    }
    const settled = await Promise.all(work.map(({ group, account }) =>
      this.fetchAccount(group, account, bounds, options.signal, options.onProgress)
        .catch((error) => {
          this.diagnostics.add({ judge: account.judge, groupId: group.id, accountId: account.id, status: "network-error", message: error.message });
          options.onProgress?.({ type: "source-crash", group, account, error });
          const base = { groupId: group.id, accountId: account.id, username: account.username, from: bounds.from, to: bounds.to };
          if (account.judge === "codeforces") {
            const failures = [];
            if (account.scopes?.problemset !== false) failures.push(failureResult({ ...base, scope: "problemset" }, "codeforces", "problemset", error));
            if (account.scopes?.gym !== false) failures.push(failureResult({ ...base, scope: "gym" }, "codeforces", "gym", error));
            return failures;
          }
          return [failureResult({ ...base, scope: "default" }, account.judge, "default", error)];
        })
    ));
    const results = settled.flat();
    for (const result of results) {
      if (result.submissions.length) await this.store.mergeSubmissions(result.submissions);
      const { submissions: _submissions, ...sourceState } = result;
      await this.store.saveSourceState(sourceIdentity(result), sourceState);
    }
    const enabledAccountIds = new Set(work.map(({ account }) => account.id));
    const submissions = (await this.store.loadSubmissions({ from: bounds.from, to: bounds.to }))
      .filter((item) => enabledAccountIds.has(item.accountId));
    const stats = aggregateDaily(submissions, results, {
      dateKeys: bounds.dateKeys,
      now,
      timeZone: config.settings.timeZone
    });
    await this.store.saveDailyStats(stats);
    await this.store.pruneSubmissions(bounds.from - 7 * 86400000);
    const incompleteCount = results.filter((result) => result.status !== "ok" || result.coverage?.complete === false).length;
    await this.store.setAtomic("last-refresh", { at: now, dateKeys: bounds.dateKeys, sourceCount: results.length, incompleteCount });
    return { results, submissions, stats, bounds };
  }

  async loadDashboard(config) {
    const bounds = windowBounds(config.settings, this.clock());
    const [stats, submissions, lastRefresh] = await Promise.all([
      this.store.loadDailyStats({ fromDate: bounds.dateKeys[0], toDate: bounds.dateKeys.at(-1) }),
      this.store.loadSubmissions({ from: bounds.from, to: bounds.to }),
      this.store.get("last-refresh", null)
    ]);
    const enabledAccounts = new Map();
    for (const group of config.groups) {
      for (const account of group.accounts) {
        if (account.enabled) enabledAccounts.set(`${group.id}:${account.id}`, account);
      }
    }
    const enabledStat = (item) => {
      const account = enabledAccounts.get(`${item.groupId}:${item.accountId}`);
      if (!account || account.judge !== item.judge) return false;
      if (item.judge !== "codeforces") return item.scope === "default";
      return account.scopes?.[item.scope] !== false;
    };
    return {
      bounds,
      stats: stats.filter(enabledStat),
      submissions: mergeSubmissions([], submissions.filter(enabledStat)),
      lastRefresh
    };
  }
}

module.exports = { Diagnostics, MonitorService, firstDateEpoch, sourceIdentity, windowBounds };

},
"src/site-bridge.js": function(module, exports, __require) {
"use strict";

const { createId, OJMonitorError } = __require("src/core.js");

const SITE_LABELS = Object.freeze({ luogu: "洛谷 www.luogu.com.cn", qoj: "QOJ" });
const ALLOWED_PATHS = Object.freeze({
  luogu: [/^\/record\/list$/, /^\/api\/user\/search$/, /^\/user\/[^/]+$/],
  qoj: [/^\/submissions$/, /^\/user\/profile\/[^/]+$/]
});

function siteFromUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "qoj.ac") return "qoj";
    if (hostname === "luogu.com.cn" || hostname.endsWith(".luogu.com.cn")) return "luogu";
  } catch {
    return null;
  }
  return null;
}

function workerSiteFromLocation(locationObject) {
  try {
    const url = new URL(locationObject?.href);
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() === "qoj.ac") return "qoj";
    if (url.hostname.toLowerCase() === "www.luogu.com.cn") return "luogu";
  } catch {
    return null;
  }
  return null;
}

function allowedBridgeUrl(site, value, base) {
  const url = new URL(value, base);
  if (siteFromUrl(url.href) !== site || !ALLOWED_PATHS[site]?.some((pattern) => pattern.test(url.pathname))) {
    throw new OJMonitorError("permission-denied", "跨标签页请求地址不在允许范围内");
  }
  return url;
}

function headerObject(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => { output[String(name).toLowerCase()] = String(value); });
    return output;
  }
  for (const [name, value] of Object.entries(headers)) output[String(name).toLowerCase()] = String(value);
  return output;
}

function headerEntries(headers) {
  const output = [];
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => output.push([String(name).toLowerCase(), String(value)]));
  } else {
    for (const [name, value] of Object.entries(headers)) output.push([String(name).toLowerCase(), String(value)]);
  }
  return output;
}

class SiteSessionBridge {
  constructor(options) {
    this.store = options.store;
    this.global = options.globalObject || globalThis;
    this.client = options.client || null;
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeout = options.timeout || 45000;
    this.pollInterval = options.pollInterval || 100;
    this.presenceMaxAge = options.presenceMaxAge || 15000;
    this.workerId = createId("site-tab");
    this.site = workerSiteFromLocation(this.global.location);
    this.listenerId = null;
    this.heartbeatId = null;
    this.processing = new Set();
    this.chains = new Map();
  }

  presenceName(site) {
    return `site-bridge:presence:${site}`;
  }

  requestName(site) {
    return `site-bridge:request:${site}`;
  }

  responseName(id) {
    return `site-bridge:response:${id}`;
  }

  async publishPresence() {
    if (!this.site) return;
    await this.store.setAtomic(this.presenceName(this.site), {
      workerId: this.workerId,
      site: this.site,
      at: this.clock()
    });
  }

  async start() {
    if (!this.site || this.listenerId !== null) return this;
    await this.publishPresence();
    this.listenerId = this.store.watch(this.requestName(this.site), (request, _old, _remote, error) => {
      if (!error && request?.id) this.handleRequest(request).catch(() => undefined);
    });
    const pending = await this.store.get(this.requestName(this.site), null);
    if (pending?.id) this.handleRequest(pending).catch(() => undefined);
    this.heartbeatId = setInterval(() => this.publishPresence().catch(() => undefined), 5000);
    return this;
  }

  async stop() {
    if (this.heartbeatId !== null) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    if (this.listenerId !== null) this.store.unwatch(this.listenerId);
    this.listenerId = null;
    const current = this.site ? await this.store.get(this.presenceName(this.site), null) : null;
    if (current?.workerId === this.workerId) await this.store.delete(this.presenceName(this.site));
  }

  async handleRequest(request) {
    if (!this.site || !this.client || this.processing.has(request.id)) return;
    if (this.clock() - Number(request.createdAt || 0) > this.timeout) return;
    this.processing.add(request.id);
    try {
      const requestedUrl = allowedBridgeUrl(this.site, request.url, this.global.location?.href);
      const localUrl = new URL(`${requestedUrl.pathname}${requestedUrl.search}`, this.global.location.origin).href;
      const response = await this.client.request(localUrl, {
        method: request.method || "GET",
        headers: request.headers || {},
        transport: "page-fetch",
        retries: 0
      });
      const pending = await this.store.get(this.requestName(this.site), null);
      if (pending?.id === request.id) {
        await this.store.setAtomic(this.responseName(request.id), {
          id: request.id,
          ok: true,
          status: response.status,
          finalUrl: response.finalUrl || localUrl,
          headers: headerEntries(response.headers),
          text: response.text,
          transport: response.transport,
          transportFallback: response.transportFallback
        });
      }
    } catch (error) {
      const pending = await this.store.get(this.requestName(this.site), null);
      if (pending?.id === request.id) {
        await this.store.setAtomic(this.responseName(request.id), {
          id: request.id,
          ok: false,
          status: error?.status || "network-error",
          message: error instanceof Error ? error.message : String(error || "跨标签页请求失败"),
          transport: error?.details?.transport,
          finalUrl: error?.details?.finalUrl,
          httpStatus: error?.details?.httpStatus,
          transportFallback: error?.details?.transportFallback
        });
      }
    } finally {
      this.processing.delete(request.id);
    }
  }

  async request(url, options = {}) {
    const site = siteFromUrl(url, this.global.location?.href);
    if (!site) throw new OJMonitorError("permission-denied", "该站点不支持跨标签页请求代理");
    allowedBridgeUrl(site, url, this.global.location?.href);
    const previous = this.chains.get(site) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.chains.set(site, tail);
    await previous;
    try {
      return await this.requestSerial(site, url, options);
    } finally {
      release();
      if (this.chains.get(site) === tail) this.chains.delete(site);
    }
  }

  async requestSerial(site, url, options) {
    const presence = await this.store.get(this.presenceName(site), null);
    if (!presence || this.clock() - Number(presence.at || 0) > this.presenceMaxAge) {
      throw new OJMonitorError(
        "source-unavailable",
        `未检测到运行新版脚本的${SITE_LABELS[site]}标签页；请打开或刷新该站点页面后重试`
      );
    }
    const id = createId("site-request");
    const requestName = this.requestName(site);
    const responseName = this.responseName(id);
    const deadline = this.clock() + (Number.isFinite(options.timeout) ? options.timeout : this.timeout);
    await this.store.setAtomic(requestName, {
      id,
      site,
      url: String(url),
      method: options.method || "GET",
      headers: headerObject(options.headers),
      createdAt: this.clock()
    });
    try {
      for (;;) {
        if (options.signal?.aborted) throw new OJMonitorError("network-error", "跨标签页请求已取消");
        const response = await this.store.get(responseName, null);
        if (response?.id === id) {
          if (!response.ok) {
            throw new OJMonitorError(response.status, response.message, {
              transport: `site-tab:${response.transport || site}`,
              finalUrl: response.finalUrl,
              httpStatus: response.httpStatus,
              transportFallback: response.transportFallback
            });
          }
          return {
            status: response.status,
            finalUrl: response.finalUrl,
            headers: new Map(response.headers || []),
            text: response.text,
            transport: `site-tab:${response.transport || site}`,
            transportFallback: response.transportFallback
          };
        }
        if (this.clock() >= deadline) {
          throw new OJMonitorError("network-error", `${SITE_LABELS[site]}标签页没有及时响应跨页面请求`);
        }
        await this.sleep(Math.min(this.pollInterval, Math.max(1, deadline - this.clock())));
      }
    } finally {
      await this.store.delete(responseName);
      const current = await this.store.get(requestName, null);
      if (current?.id === id) await this.store.delete(requestName);
    }
  }
}

module.exports = { ALLOWED_PATHS, SiteSessionBridge, allowedBridgeUrl, headerEntries, headerObject, siteFromUrl, workerSiteFromLocation };

},
"src/storage.js": function(module, exports, __require) {
"use strict";

const { buildSubmissionKey, defaultConfig, mergeSubmissions, normalizeConfig } = __require("src/core.js");

const PREFIX = "oj-monitor:v1:";

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

class MemoryBackend {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.listeners = new Map();
    this.nextListenerId = 1;
  }

  async get(key, fallback = undefined) {
    return this.values.has(key) ? this.values.get(key) : fallback;
  }

  async set(key, value) {
    const oldValue = this.values.get(key);
    this.values.set(key, value);
    for (const listener of this.listeners.values()) {
      if (listener.key === key) listener.callback(key, oldValue, value, false);
    }
  }

  async delete(key) {
    const oldValue = this.values.get(key);
    this.values.delete(key);
    for (const listener of this.listeners.values()) {
      if (listener.key === key) listener.callback(key, oldValue, undefined, false);
    }
  }

  async list() {
    return [...this.values.keys()];
  }

  addListener(key, callback) {
    const id = this.nextListenerId++;
    this.listeners.set(id, { key, callback });
    return id;
  }

  removeListener(id) {
    this.listeners.delete(id);
  }
}

class GMBackend {
  constructor(globalObject = globalThis) {
    this.global = globalObject;
    this.memoryFallback = new MemoryBackend();
  }

  async get(key, fallback = undefined) {
    if (typeof this.global.GM_getValue === "function") return await this.global.GM_getValue(key, fallback);
    return this.memoryFallback.get(key, fallback);
  }

  async set(key, value) {
    if (typeof this.global.GM_setValue === "function") return await this.global.GM_setValue(key, value);
    return this.memoryFallback.set(key, value);
  }

  async delete(key) {
    if (typeof this.global.GM_deleteValue === "function") return await this.global.GM_deleteValue(key);
    return this.memoryFallback.delete(key);
  }

  async list() {
    if (typeof this.global.GM_listValues === "function") return await this.global.GM_listValues();
    return this.memoryFallback.list();
  }

  addListener(key, callback) {
    if (typeof this.global.GM_addValueChangeListener === "function") {
      return this.global.GM_addValueChangeListener(key, callback);
    }
    return this.memoryFallback.addListener(key, callback);
  }

  removeListener(id) {
    if (typeof this.global.GM_removeValueChangeListener === "function") {
      return this.global.GM_removeValueChangeListener(id);
    }
    return this.memoryFallback.removeListener(id);
  }
}

function encodeEnvelope(value) {
  const payload = JSON.stringify(value);
  return JSON.stringify({ schemaVersion: 1, checksum: fnv1a(payload), payload });
}

function decodeEnvelope(serialized, fallback) {
  if (serialized === undefined || serialized === null) return fallback;
  if (typeof serialized !== "string") return serialized;
  const envelope = JSON.parse(serialized);
  if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.payload !== "string") {
    throw new Error("Unsupported storage envelope");
  }
  if (fnv1a(envelope.payload) !== envelope.checksum) throw new Error("Storage checksum mismatch");
  return JSON.parse(envelope.payload);
}

class Store {
  constructor(backend = new GMBackend()) {
    this.backend = backend;
  }

  key(name) {
    return `${PREFIX}${name}`;
  }

  async get(name, fallback = undefined) {
    return decodeEnvelope(await this.backend.get(this.key(name)), fallback);
  }

  async setAtomic(name, value) {
    const key = this.key(name);
    const temporary = `${key}:tmp`;
    const encoded = encodeEnvelope(value);
    await this.backend.set(temporary, encoded);
    decodeEnvelope(await this.backend.get(temporary), undefined);
    await this.backend.set(key, encoded);
    decodeEnvelope(await this.backend.get(key), undefined);
    await this.backend.delete(temporary);
    return value;
  }

  async delete(name) {
    await this.backend.delete(this.key(name));
  }

  watch(name, callback) {
    return this.backend.addListener(this.key(name), (_key, oldValue, newValue, remote) => {
      let decodedOld;
      let decodedNew;
      try {
        decodedOld = decodeEnvelope(oldValue, undefined);
        decodedNew = decodeEnvelope(newValue, undefined);
      } catch (error) {
        callback(undefined, undefined, remote, error);
        return;
      }
      callback(decodedNew, decodedOld, remote, null);
    });
  }

  unwatch(listenerId) {
    this.backend.removeListener(listenerId);
  }

  async loadConfig() {
    return normalizeConfig(await this.get("config", defaultConfig()));
  }

  async saveConfig(config) {
    const normalized = normalizeConfig(config);
    await this.setAtomic("config", normalized);
    return normalized;
  }

  monthChunkName(submission) {
    const date = new Date(submission.submittedAt);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return `submissions:${submission.accountId}:${submission.judge}:${submission.scope}:${month}`;
  }

  async mergeSubmissions(submissions) {
    const chunks = new Map();
    for (const submission of submissions) {
      const name = this.monthChunkName(submission);
      if (!chunks.has(name)) chunks.set(name, []);
      chunks.get(name).push(submission);
    }
    const index = new Set(await this.get("submission-index", []));
    for (const [name, incoming] of chunks) {
      const existing = await this.get(name, []);
      await this.setAtomic(name, mergeSubmissions(existing, incoming));
      index.add(name);
    }
    await this.setAtomic("submission-index", [...index].sort());
  }

  async loadSubmissions(filter = {}) {
    const names = await this.get("submission-index", []);
    const output = [];
    for (const name of names) {
      const items = await this.get(name, []);
      for (const item of items) {
        if (filter.accountId && item.accountId !== filter.accountId) continue;
        if (filter.judge && item.judge !== filter.judge) continue;
        if (filter.scope && item.scope !== filter.scope) continue;
        if (Number.isFinite(filter.from) && item.submittedAt < filter.from) continue;
        if (Number.isFinite(filter.to) && item.submittedAt > filter.to) continue;
        output.push(item);
      }
    }
    return mergeSubmissions([], output);
  }

  async removeAccount(accountId) {
    const names = await this.get("submission-index", []);
    const keep = [];
    for (const name of names) {
      if (name.startsWith(`submissions:${accountId}:`)) await this.delete(name);
      else keep.push(name);
    }
    await this.setAtomic("submission-index", keep);
    const statNames = await this.get("stats-index", []);
    const keepStats = [];
    for (const name of statNames) {
      const parts = name.split(":");
      if (parts[0] === "stats" && parts[2] === accountId) await this.delete(name);
      else keepStats.push(name);
    }
    await this.setAtomic("stats-index", keepStats);
    const sourcePrefix = `${PREFIX}source:`;
    for (const key of await this.backend.list()) {
      if (!key.startsWith(sourcePrefix)) continue;
      const parts = key.slice(PREFIX.length).split(":");
      if (parts[0] === "source" && parts[2] === accountId) await this.backend.delete(key);
    }
  }

  async pruneSubmissions(cutoff) {
    const names = await this.get("submission-index", []);
    const keep = [];
    for (const name of names) {
      const retained = (await this.get(name, [])).filter((item) => item.submittedAt >= cutoff);
      if (retained.length) {
        await this.setAtomic(name, retained);
        keep.push(name);
      } else {
        await this.delete(name);
      }
    }
    await this.setAtomic("submission-index", keep);
  }

  async saveDailyStats(stats) {
    const chunks = new Map();
    for (const stat of stats) {
      const year = stat.date.slice(0, 4);
      const name = `stats:${stat.groupId}:${stat.accountId}:${stat.judge}:${stat.scope}:${year}`;
      if (!chunks.has(name)) chunks.set(name, []);
      chunks.get(name).push(stat);
    }
    const index = new Set(await this.get("stats-index", []));
    for (const [name, incoming] of chunks) {
      const existing = await this.get(name, []);
      const merged = new Map(existing.map((item) => [[item.groupId, item.accountId, item.judge, item.scope, item.date].join(":"), item]));
      for (const item of incoming) merged.set([item.groupId, item.accountId, item.judge, item.scope, item.date].join(":"), item);
      await this.setAtomic(name, [...merged.values()].sort((left, right) => left.date.localeCompare(right.date)));
      index.add(name);
    }
    await this.setAtomic("stats-index", [...index].sort());
  }

  async loadDailyStats(filter = {}) {
    const names = await this.get("stats-index", []);
    const stats = [];
    for (const name of names) {
      for (const stat of await this.get(name, [])) {
        if (filter.groupId && stat.groupId !== filter.groupId) continue;
        if (filter.accountId && stat.accountId !== filter.accountId) continue;
        if (filter.fromDate && stat.date < filter.fromDate) continue;
        if (filter.toDate && stat.date > filter.toDate) continue;
        stats.push(stat);
      }
    }
    return stats;
  }

  async saveSourceState(identity, state) {
    return this.setAtomic(`source:${identity}`, state);
  }

  async loadSourceState(identity) {
    return this.get(`source:${identity}`, null);
  }

  async debugSnapshot() {
    const keys = (await this.backend.list()).filter((key) => key.startsWith(PREFIX) && !key.endsWith(":tmp"));
    return { keys: keys.sort(), submissionKeys: (await this.loadSubmissions()).map(buildSubmissionKey) };
  }
}

module.exports = { GMBackend, MemoryBackend, Store, decodeEnvelope, encodeEnvelope, fnv1a, PREFIX };

},
"src/ui.js": function(module, exports, __require) {
"use strict";

const { createId, normalizeConfig, recentDateKeys, zonedDateKey } = __require("src/core.js");
const {
  SOURCE_FILTERS,
  buildDailyRows,
  buildGroupRows,
  buildHeatmapSeries,
  filterSubmissions,
  levelLabelsFor
} = __require("src/view-model.js");

const STATUS_LABELS = Object.freeze({
  ok: "正常",
  loading: "正在加载",
  "not-found": "用户不存在",
  "login-required": "需要登录本地 OJ 账号",
  "verification-required": "需要浏览器验证",
  "permission-denied": "本地账号无查看权限",
  "rate-limited": "请求频率过高",
  "schema-changed": "页面结构可能已变化",
  "source-unavailable": "数据源暂时不可用",
  partial: "数据可能不完整",
  "network-error": "网络错误"
});

const JUDGE_LABELS = Object.freeze({ codeforces: "Codeforces", atcoder: "AtCoder", vjudge: "VJudge", luogu: "洛谷", nowcoder: "牛客", qoj: "QOJ" });

function accountUsernameChanged(account, nextUsername) {
  return String(account?.username || "").trim() !== String(nextUsername || "").trim();
}

function accountIdentifierLabel(judge) {
  return judge === "nowcoder" ? "牛客竞赛用户名或数字 UID" : `${JUDGE_LABELS[judge] || judge} 用户名`;
}

const CSS = `
#oj-monitor-root, #oj-monitor-root * { box-sizing: border-box; }
#oj-monitor-entry { position: fixed; z-index: 2147483645; right: 16px; top: 72px; border: 0; border-radius: 999px; background: #2563eb; color: #fff; padding: 9px 14px; font: 600 13px/1.2 system-ui,sans-serif; box-shadow: 0 4px 16px #0003; cursor: pointer; }
#oj-monitor-root { --oj-bg:#fff; --oj-panel:#f6f8fa; --oj-text:#1f2328; --oj-muted:#656d76; --oj-border:#d0d7de; --oj-accent:#0969da; --oj-level0:#ebedf0; --oj-level1:#9be9a8; --oj-level2:#40c463; --oj-level3:#30a14e; --oj-level4:#216e39; position:fixed; inset:0; z-index:2147483646; background:#0008; color:var(--oj-text); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
#oj-monitor-root.oj-monitor-hidden { display:none; }
#oj-monitor-root.oj-monitor-theme-light { --oj-bg:#fff; --oj-panel:#f6f8fa; --oj-text:#1f2328; --oj-muted:#656d76; --oj-border:#d0d7de; --oj-accent:#0969da; --oj-level0:#ebedf0; --oj-level1:#9be9a8; --oj-level2:#40c463; --oj-level3:#30a14e; --oj-level4:#216e39; }
#oj-monitor-root.oj-monitor-theme-dark { --oj-bg:#0d1117; --oj-panel:#161b22; --oj-text:#e6edf3; --oj-muted:#8b949e; --oj-border:#30363d; --oj-accent:#58a6ff; --oj-level0:#161b22; --oj-level1:#0e4429; --oj-level2:#006d32; --oj-level3:#26a641; --oj-level4:#39d353; }
@media (prefers-color-scheme: dark) { #oj-monitor-root { --oj-bg:#0d1117; --oj-panel:#161b22; --oj-text:#e6edf3; --oj-muted:#8b949e; --oj-border:#30363d; --oj-accent:#58a6ff; --oj-level0:#161b22; --oj-level1:#0e4429; --oj-level2:#006d32; --oj-level3:#26a641; --oj-level4:#39d353; } }
.oj-monitor-shell { position:absolute; inset:3vh 3vw; max-width:1500px; margin:auto; display:flex; flex-direction:column; background:var(--oj-bg); border:1px solid var(--oj-border); border-radius:12px; box-shadow:0 20px 70px #0008; overflow:hidden; }
.oj-monitor-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--oj-border); background:var(--oj-panel); }
.oj-monitor-title { margin:0 auto 0 0; font-size:18px; }
.oj-monitor-control-label { display:inline-flex; align-items:center; gap:5px; color:var(--oj-muted); white-space:nowrap; }
.oj-monitor-body { overflow:auto; padding:16px; flex:1; }
.oj-monitor-section { margin:0 0 16px; padding:14px; border:1px solid var(--oj-border); border-radius:8px; background:var(--oj-bg); }
.oj-monitor-section h2,.oj-monitor-section h3 { margin:0 0 10px; font-size:15px; }
.oj-monitor-control,.oj-monitor-button,.oj-monitor-input,.oj-monitor-select { min-height:32px; border:1px solid var(--oj-border); border-radius:6px; color:var(--oj-text); background:var(--oj-bg); padding:5px 9px; font:inherit; }
.oj-monitor-button { cursor:pointer; }
.oj-monitor-button-primary { border-color:var(--oj-accent); background:var(--oj-accent); color:#fff; }
.oj-monitor-button-danger { color:#cf222e; }
.oj-monitor-muted { color:var(--oj-muted); }
.oj-monitor-banner { margin:0 0 12px; padding:9px 11px; border-radius:6px; background:var(--oj-panel); white-space:pre-wrap; }
.oj-monitor-banner[data-status="partial"],.oj-monitor-banner[data-status="verification-required"],.oj-monitor-banner[data-status="login-required"] { border-left:4px solid #bf8700; }
.oj-monitor-heatmap-row { display:flex; align-items:flex-start; gap:12px; margin:10px 0; overflow:auto; }
.oj-monitor-heatmap-label { width:120px; flex:0 0 120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-top:2px; font-weight:600; }
.oj-monitor-heatmap { display:grid; grid-template-rows:repeat(7,12px); grid-auto-flow:column; grid-auto-columns:12px; gap:3px; }
.oj-monitor-day { width:12px; height:12px; padding:0; border:0; border-radius:2px; background:var(--oj-level0); cursor:pointer; }
.oj-monitor-day[data-level="1"] { background:var(--oj-level1); }.oj-monitor-day[data-level="2"] { background:var(--oj-level2); }.oj-monitor-day[data-level="3"] { background:var(--oj-level3); }.oj-monitor-day[data-level="4"] { background:var(--oj-level4); }
.oj-monitor-day[data-partial="true"] { outline:1px dashed #bf8700; outline-offset:1px; }
.oj-monitor-day-pad { visibility:hidden; }
.oj-monitor-legend { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; color:var(--oj-muted); font-size:12px; }.oj-monitor-legend-item { display:inline-flex; align-items:center; gap:3px; }.oj-monitor-legend-item i { width:12px; height:12px; border-radius:2px; background:var(--oj-level0); }.oj-monitor-legend-item[data-level="1"] i{background:var(--oj-level1)}.oj-monitor-legend-item[data-level="2"] i{background:var(--oj-level2)}.oj-monitor-legend-item[data-level="3"] i{background:var(--oj-level3)}.oj-monitor-legend-item[data-level="4"] i{background:var(--oj-level4)}
.oj-monitor-table-wrap { overflow:auto; }.oj-monitor-table { border-collapse:collapse; width:100%; min-width:760px; }.oj-monitor-table th,.oj-monitor-table td { border-bottom:1px solid var(--oj-border); padding:7px 8px; text-align:left; white-space:nowrap; }.oj-monitor-table th { position:sticky; top:0; background:var(--oj-panel); }
.oj-monitor-section-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }.oj-monitor-section-head h2 { margin:0 auto 0 0; }
.oj-monitor-status { display:inline-block; border-radius:999px; padding:2px 7px; background:var(--oj-panel); font-size:12px; }.oj-monitor-status[data-status="ok"] { color:#1a7f37; }.oj-monitor-status:not([data-status="ok"]){color:#9a6700;}
.oj-monitor-settings { position:absolute; inset:7% 8%; overflow:auto; padding:16px; background:var(--oj-bg); border:1px solid var(--oj-border); border-radius:10px; box-shadow:0 10px 50px #0008; }
.oj-monitor-settings-head,.oj-monitor-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.oj-monitor-settings-head { margin-bottom:14px; }.oj-monitor-settings-head h2 { margin:0 auto 0 0; }
.oj-monitor-group-editor { border:1px solid var(--oj-border); border-radius:8px; margin:10px 0; padding:10px; }.oj-monitor-account { margin:8px 0 0 20px; padding:8px; background:var(--oj-panel); border-radius:6px; }
.oj-monitor-details-list { list-style:none; padding:0; margin:0; }.oj-monitor-details-list li { display:grid; grid-template-columns:150px 100px 1fr 150px; gap:8px; padding:6px 0; border-bottom:1px solid var(--oj-border); }.oj-monitor-details-list a { color:var(--oj-accent); }
@media (max-width:700px) { .oj-monitor-shell { inset:0; border-radius:0; }.oj-monitor-header { align-items:stretch; }.oj-monitor-title { width:100%; }.oj-monitor-settings { inset:2%; }.oj-monitor-details-list li { grid-template-columns:1fr; }.oj-monitor-heatmap-label { width:80px; flex-basis:80px; } }
`;

function element(documentObject, tag, attributes = {}, children = []) {
  const node = documentObject.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(name, "");
    else if (value !== false && value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : documentObject.createTextNode(String(child)));
  }
  return node;
}

function option(documentObject, value, label, selected = false) {
  return element(documentObject, "option", { value, text: label, selected });
}

function statusBadge(documentObject, status, suffix = "") {
  return element(documentObject, "span", { class: "oj-monitor-status", "data-status": status, text: `${STATUS_LABELS[status] || status}${suffix}` });
}

function verdictText(item) {
  const verdict = String(item?.verdict || "UNKNOWN").trim();
  if (!item?.accepted || /[✓✔√]\s*$/.test(verdict)) return verdict;
  return `${verdict} ✓`;
}

function cellText(cell) {
  const prefix = cell.coverageComplete ? "" : "≥";
  return `${prefix}${cell.solvedCount}/${prefix}${cell.submissionCount}`;
}

function displayCoverageStatus(cell) {
  return cell.coverageComplete ? cell.status : cell.status && cell.status !== "ok" ? cell.status : "partial";
}

function sourceIssueText(event) {
  const result = event?.result;
  if (!result || result.status === "ok" && result.coverage?.complete !== false) return null;
  const source = `${event.group?.name || "未知分组"} / ${JUDGE_LABELS[event.account?.judge] || event.account?.judge || "未知来源"}`;
  const status = STATUS_LABELS[result.status] || result.status || "数据不完整";
  const reason = result.warning || result.coverage?.reason;
  return `${source}：${status}${reason ? ` — ${reason}` : ""}`;
}

function sharedRefreshNotice(lastRefresh) {
  const incompleteCount = Number(lastRefresh?.incompleteCount || 0);
  return incompleteCount > 0
    ? { text: `已读取另一个标签页完成的共享结果；有 ${incompleteCount} 个来源未完整覆盖，请查看每日表格状态。`, status: "partial" }
    : { text: "已读取另一个标签页完成的共享结果。", status: "ok" };
}

class MonitorPanel {
  constructor(options) {
    this.global = options.globalObject || globalThis;
    this.document = this.global.document;
    this.store = options.store;
    this.service = options.service;
    this.onRefresh = options.onRefresh;
    this.onCancel = options.onCancel;
    this.config = normalizeConfig(options.config);
    this.data = { stats: [], submissions: [], lastRefresh: null, bounds: { dateKeys: recentDateKeys(this.config.settings.days, Date.now(), this.config.settings.timeZone) } };
    this.selectedGroup = this.config.groups[0]?.id || "all";
    this.source = "all";
    this.metric = this.config.settings.metric;
    this.dailyTableExpanded = true;
    this.refreshIssues = [];
    this.refreshing = false;
    this.autoRefreshed = false;
  }

  mount() {
    if (typeof this.global.GM_addStyle === "function") this.global.GM_addStyle(CSS);
    else this.document.head.append(element(this.document, "style", { text: CSS }));
    this.entry = element(this.document, "button", { id: "oj-monitor-entry", type: "button", text: "OJ 监测", onclick: () => this.open() });
    this.root = element(this.document, "div", { id: "oj-monitor-root", class: "oj-monitor-hidden" });
    this.document.body.append(this.entry, this.root);
    if (typeof this.global.GM_registerMenuCommand === "function") this.global.GM_registerMenuCommand("打开 OJ 监测面板", () => this.open());
    this.listenerId = this.store.watch("config", (next, _old, remote, error) => {
      if (!error && remote && next) {
        this.config = normalizeConfig(next);
        this.ensureSelection();
        if (!this.root.classList.contains("oj-monitor-hidden")) this.loadAndRender();
      }
    });
    this.dataListenerId = this.store.watch("last-refresh", (next, _old, remote, error) => {
      if (!error && remote && !this.root.classList.contains("oj-monitor-hidden")) {
        this.loadAndRender().then(() => {
          if (this.noticeStatus === "loading" && /另一个标签页/.test(this.notice || "")) {
            const shared = sharedRefreshNotice(next);
            this.notice = shared.text;
            this.noticeStatus = shared.status;
            this.render();
          }
        });
      }
    });
  }

  ensureSelection() {
    if (this.selectedGroup !== "all" && !this.config.groups.some((group) => group.id === this.selectedGroup)) {
      this.selectedGroup = this.config.groups[0]?.id || "all";
    }
  }

  async open() {
    this.root.classList.remove("oj-monitor-hidden");
    await this.loadAndRender();
    const staleAfter = this.config.settings.autoRefreshMinutes * 60 * 1000;
    if (!this.autoRefreshed && this.config.groups.length && (!this.data.lastRefresh || Date.now() - this.data.lastRefresh.at > staleAfter)) {
      this.autoRefreshed = true;
      await this.refresh();
    }
  }

  close() {
    this.root.classList.add("oj-monitor-hidden");
  }

  async loadAndRender() {
    this.data = await this.service.loadDashboard(this.config);
    this.render();
  }

  async saveConfig(config) {
    this.config = await this.store.saveConfig(config);
    this.ensureSelection();
    await this.loadAndRender();
  }

  render() {
    this.root.classList.toggle("oj-monitor-theme-light", this.config.settings.theme === "light");
    this.root.classList.toggle("oj-monitor-theme-dark", this.config.settings.theme === "dark");
    this.root.replaceChildren();
    const shell = element(this.document, "div", { class: "oj-monitor-shell" });
    shell.append(this.renderHeader(), this.renderBody());
    this.root.append(shell);
  }

  renderHeader() {
    const groupSelect = element(this.document, "select", { class: "oj-monitor-select", title: "选择监测对象", onchange: (event) => { this.selectedGroup = event.target.value; this.render(); } }, [
      option(this.document, "all", "全部分组（比较）", this.selectedGroup === "all"),
      ...this.config.groups.map((group) => option(this.document, group.id, group.name, group.id === this.selectedGroup))
    ]);
    const sourceSelect = element(this.document, "select", { class: "oj-monitor-select", title: "数据来源", onchange: (event) => { this.source = event.target.value; this.render(); } },
      SOURCE_FILTERS.map((item) => option(this.document, item.id, item.label, item.id === this.source))
    );
    const metricSelect = element(this.document, "select", { class: "oj-monitor-select", title: "热力图指标", onchange: async (event) => {
      this.metric = event.target.value;
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, metric: this.metric } });
    } }, [option(this.document, "solved", "通过题数", this.metric === "solved"), option(this.document, "submissions", "提交次数", this.metric === "submissions")]);
    const daysSelect = element(this.document, "select", { class: "oj-monitor-select", title: "时间窗口", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, days: Number(event.target.value) } });
    } }, [7, 14, 30, 60, 90].map((days) => option(this.document, days, `近 ${days} 天`, days === this.config.settings.days)));
    const timezoneSelect = element(this.document, "select", { class: "oj-monitor-select", title: "自然日时区", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, timeZone: event.target.value } });
    } }, [option(this.document, "local", "本地时区", this.config.settings.timeZone === "local"), option(this.document, "Asia/Shanghai", "北京时间", this.config.settings.timeZone === "Asia/Shanghai")]);
    return element(this.document, "header", { class: "oj-monitor-header" }, [
      element(this.document, "h1", { class: "oj-monitor-title", text: "OJ Monitor" }),
      groupSelect, sourceSelect,
      element(this.document, "label", { class: "oj-monitor-control-label" }, ["热力图指标：", metricSelect]),
      daysSelect, timezoneSelect,
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", type: "button", text: this.refreshing ? "取消获取" : "重新获取", onclick: () => this.refreshing ? this.cancelRefresh() : this.refresh() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "管理分组", onclick: () => this.renderSettings() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "诊断", onclick: () => this.showDiagnostics() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "关闭", onclick: () => this.close() })
    ]);
  }

  renderBody() {
    const body = element(this.document, "main", { class: "oj-monitor-body" });
    if (this.notice) body.append(element(this.document, "div", { class: "oj-monitor-banner", "data-status": this.noticeStatus || "ok", text: this.notice }));
    if (!this.config.groups.length) {
      body.append(element(this.document, "section", { class: "oj-monitor-section" }, [
        element(this.document, "h2", { text: "还没有监测对象" }),
        element(this.document, "p", { class: "oj-monitor-muted", text: "先创建一个以人名命名的分组，再为其添加各 OJ 用户名。" }),
        element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "创建第一个分组", onclick: () => this.renderSettings(true) })
      ]));
      return body;
    }
    if (!this.data.lastRefresh) body.append(element(this.document, "div", { class: "oj-monitor-banner", text: "尚未获取数据；打开面板后会自动获取一次，也可点击“重新获取”。" }));
    body.append(this.renderHeatmap(), this.renderTable());
    if (this.detailDate && this.selectedGroup !== "all") body.append(this.renderDetails());
    return body;
  }

  visibleGroups() {
    return this.selectedGroup === "all" ? this.config.groups : this.config.groups.filter((group) => group.id === this.selectedGroup);
  }

  renderHeatmap() {
    const groups = this.visibleGroups();
    const series = buildHeatmapSeries(this.data.stats, groups, this.data.bounds.dateKeys, { metric: this.metric, source: this.source });
    const section = element(this.document, "section", { class: "oj-monitor-section" }, [element(this.document, "h2", { text: `${SOURCE_FILTERS.find((item) => item.id === this.source)?.label || "全部网站"} · ${this.metric === "solved" ? "每日过题" : "每日提交"}` })]);
    for (const row of series) {
      const grid = element(this.document, "div", { class: "oj-monitor-heatmap", role: "grid", "aria-label": `${row.name} 热力图` });
      const offset = new Date(`${row.days[0].date}T00:00:00Z`).getUTCDay();
      for (let index = 0; index < offset; index += 1) grid.append(element(this.document, "i", { class: "oj-monitor-day oj-monitor-day-pad" }));
      for (const day of row.days) {
        const title = `${day.date}：${day.solvedCount} 题 / ${day.submissionCount} 次提交${day.coverageComplete ? "" : "（数据至少为此值）"}${day.excludedCount ? `；${day.excludedCount} 条未支持记录` : ""}`;
        grid.append(element(this.document, "button", {
          class: "oj-monitor-day", type: "button", "data-level": day.level, "data-partial": !day.coverageComplete,
          title, "aria-label": title,
          onclick: () => { this.selectedGroup = row.groupId; this.detailDate = day.date; this.render(); }
        }));
      }
      section.append(element(this.document, "div", { class: "oj-monitor-heatmap-row" }, [element(this.document, "div", { class: "oj-monitor-heatmap-label", text: row.name, title: row.name }), grid]));
    }
    section.append(element(this.document, "div", { class: "oj-monitor-legend", "aria-label": "热力图颜色档位" }, [
      element(this.document, "span", { text: this.metric === "solved" ? "通过题数：" : "提交次数：" }),
      ...levelLabelsFor(this.metric).map((label, level) => element(this.document, "span", { class: "oj-monitor-legend-item", "data-level": level }, [element(this.document, "i"), label]))
    ]));
    return section;
  }

  renderTable() {
    const section = element(this.document, "section", { class: "oj-monitor-section" });
    const sourceLabel = SOURCE_FILTERS.find((item) => item.id === this.source)?.label || "全部网站";
    const title = element(this.document, "h2", {
      text: this.selectedGroup === "all" ? `分组比较 · ${sourceLabel}` : "逐日统计（过题/提交）"
    });
    if (this.selectedGroup === "all") section.append(title);
    else {
      section.append(element(this.document, "div", { class: "oj-monitor-section-head" }, [
        title,
        element(this.document, "button", {
          class: "oj-monitor-button", type: "button",
          text: this.dailyTableExpanded ? "收起逐日统计" : "展开逐日统计",
          "aria-expanded": this.dailyTableExpanded,
          onclick: () => { this.dailyTableExpanded = !this.dailyTableExpanded; this.render(); }
        })
      ]));
      if (!this.dailyTableExpanded) return section;
    }
    const table = element(this.document, "table", { class: "oj-monitor-table" });
    if (this.selectedGroup === "all") {
      table.append(element(this.document, "thead", {}, element(this.document, "tr", {}, ["分组", "过题数", "提交数", "排除记录", "数据状态"].map((text) => element(this.document, "th", { text })) )));
      const tbody = element(this.document, "tbody");
      for (const row of buildGroupRows(this.data.stats, this.config.groups, this.data.bounds.dateKeys, this.source)) {
        tbody.append(element(this.document, "tr", {}, [
          element(this.document, "td", { text: row.name }), element(this.document, "td", { text: row.coverageComplete ? row.solvedCount : `≥${row.solvedCount}` }),
          element(this.document, "td", { text: row.coverageComplete ? row.submissionCount : `≥${row.submissionCount}` }), element(this.document, "td", { text: row.excludedCount }),
          element(this.document, "td", {}, statusBadge(this.document, displayCoverageStatus(row)))
        ]));
      }
      table.append(tbody);
    } else {
      const group = this.config.groups.find((item) => item.id === this.selectedGroup);
      const hasSource = (judge, scope) => group?.accounts.some((account) => account.enabled && account.judge === judge && (judge !== "codeforces" || account.scopes?.[scope] !== false));
      table.append(element(this.document, "thead", {}, element(this.document, "tr", {}, ["日期", "CF Problemset", "CF Gym", "AtCoder", "VJudge", "洛谷", "牛客", "QOJ", "合计", "状态"].map((text) => element(this.document, "th", { text })) )));
      const tbody = element(this.document, "tbody");
      for (const row of buildDailyRows(this.data.stats, this.selectedGroup, this.data.bounds.dateKeys)) {
        const sourceCells = [
          [row.problemset, hasSource("codeforces", "problemset")], [row.gym, hasSource("codeforces", "gym")],
          [row.atcoder, hasSource("atcoder")], [row.vjudge, hasSource("vjudge")], [row.luogu, hasSource("luogu")], [row.nowcoder, hasSource("nowcoder")], [row.qoj, hasSource("qoj")]
        ];
        tbody.append(element(this.document, "tr", { onclick: () => { this.detailDate = row.date; this.render(); } }, [
          element(this.document, "td", { text: row.date }), ...sourceCells.map(([cell, exists]) => element(this.document, "td", { text: exists ? cellText(cell) : "—" })), element(this.document, "td", { text: cellText(row.total) }),
          element(this.document, "td", {}, statusBadge(this.document, displayCoverageStatus(row.total)))
        ]));
      }
      table.append(tbody);
    }
    section.append(element(this.document, "div", { class: "oj-monitor-table-wrap" }, table));
    return section;
  }

  renderDetails() {
    const group = this.config.groups.find((item) => item.id === this.selectedGroup);
    const submissions = filterSubmissions(this.data.submissions, this.selectedGroup, this.detailDate, this.config.settings.timeZone, this.source, zonedDateKey);
    const list = element(this.document, "ul", { class: "oj-monitor-details-list" });
    for (const item of submissions) {
      const link = element(this.document, "a", { href: item.problemUrl || "#", target: "_blank", rel: "noopener noreferrer", text: item.problemName || item.problemKey });
      list.append(element(this.document, "li", {}, [
        element(this.document, "time", { text: new Date(item.submittedAt).toLocaleString() }),
        element(this.document, "span", { text: `${JUDGE_LABELS[item.judge]}${item.scope === "default" ? "" : ` / ${item.scope}`}` }),
        link,
        element(this.document, "span", { text: verdictText(item) })
      ]));
    }
    return element(this.document, "section", { class: "oj-monitor-section" }, [
      element(this.document, "h2", { text: `${group?.name || ""} · ${this.detailDate} 提交明细` }),
      submissions.length ? list : element(this.document, "p", { class: "oj-monitor-muted", text: "当前筛选下没有已取得的提交。" })
    ]);
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshIssues = [];
    this.notice = "正在获取各 OJ 数据…";
    this.noticeStatus = "loading";
    this.render();
    try {
      const response = await this.onRefresh((event) => {
        if (event.type === "lease-wait") {
          this.notice = "另一个标签页正在获取数据；本页会等待共享结果，并在租约失效后自动接管。";
          this.noticeStatus = "loading";
          this.render();
        } else if (event.type === "lease-takeover") {
          this.notice = "原获取标签页已退出或租约过期，本页正在自动接管…";
          this.noticeStatus = "loading";
          this.render();
        } else if (event.type === "source-complete") {
          const issue = sourceIssueText(event);
          if (issue) this.refreshIssues.push(issue);
          this.notice = issue || `${event.group.name} / ${JUDGE_LABELS[event.account.judge]}：正常`;
          this.noticeStatus = event.result.status;
          this.render();
        } else if (event.type === "source-crash") {
          const issue = sourceIssueText({
            ...event,
            result: { status: event.error?.status || "network-error", coverage: { complete: false }, warning: event.error?.message }
          });
          if (issue) this.refreshIssues.push(issue);
          this.notice = issue;
          this.noticeStatus = event.error?.status || "network-error";
          this.render();
        }
      });
      if (response?.acquired === false && response?.shared === true) {
        const shared = sharedRefreshNotice(response.value);
        this.notice = shared.text;
        this.noticeStatus = shared.status;
      } else if (response?.acquired === false) {
        this.notice = "未能取得刷新租约，请关闭无响应的 OJ 标签页后重试。";
        this.noticeStatus = "network-error";
      } else {
        this.notice = this.refreshIssues.length
          ? `获取完成，但有 ${this.refreshIssues.length} 个来源未完整覆盖：\n${this.refreshIssues.join("\n")}`
          : `获取完成：${new Date().toLocaleString()}`;
        this.noticeStatus = this.refreshIssues.length ? "partial" : "ok";
      }
      await this.loadAndRender();
    } catch (error) {
      this.notice = `获取失败：${error.message}`;
      this.noticeStatus = error.status || "network-error";
      await this.loadAndRender();
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  cancelRefresh() {
    this.onCancel?.();
    this.notice = "正在取消请求…";
    this.noticeStatus = "loading";
    this.render();
  }

  renderSettings(createInitial = false) {
    this.render();
    const overlay = element(this.document, "section", { class: "oj-monitor-settings" });
    overlay.append(element(this.document, "div", { class: "oj-monitor-settings-head" }, [
      element(this.document, "h2", { text: "管理监测分组" }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "新建分组", onclick: async () => {
        const name = this.global.prompt?.("分组名称（通常填写被监测者姓名）", "新监测对象");
        if (!name?.trim()) return;
        const now = Date.now();
        const group = { id: createId("group"), name: name.trim(), accounts: [], sortOrder: this.config.groups.length, createdAt: now, updatedAt: now };
        this.selectedGroup = group.id;
        await this.saveConfig({ ...this.config, groups: [...this.config.groups, group] });
        this.renderSettings();
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "返回面板", onclick: () => this.render() })
    ]));
    const theme = element(this.document, "select", { class: "oj-monitor-select", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, theme: event.target.value } });
      this.renderSettings();
    } }, ["system", "light", "dark"].map((value) => option(this.document, value, { system: "跟随系统", light: "浅色", dark: "深色" }[value], this.config.settings.theme === value)));
    const refreshInterval = element(this.document, "select", { class: "oj-monitor-select", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, autoRefreshMinutes: Number(event.target.value) } });
      this.renderSettings();
    } }, [15, 30, 60].map((value) => option(this.document, value, `${value} 分钟自动刷新间隔`, this.config.settings.autoRefreshMinutes === value)));
    overlay.append(element(this.document, "div", { class: "oj-monitor-row" }, [element(this.document, "span", { text: "外观：" }), theme, element(this.document, "span", { text: "打开面板时的缓存有效期：" }), refreshInterval]));
    for (const [groupIndex, group] of this.config.groups.entries()) overlay.append(this.renderGroupEditor(group, groupIndex));
    this.root.querySelector(".oj-monitor-shell").append(overlay);
    if (createInitial && !this.config.groups.length) overlay.querySelector("button")?.focus();
  }

  renderGroupEditor(group, groupIndex) {
    const nameInput = element(this.document, "input", { class: "oj-monitor-input", value: group.name, "aria-label": "分组名称" });
    const container = element(this.document, "article", { class: "oj-monitor-group-editor" });
    const updateGroups = async (groups) => { await this.saveConfig({ ...this.config, groups }); this.renderSettings(); };
    container.append(element(this.document, "div", { class: "oj-monitor-row" }, [
      nameInput,
      element(this.document, "button", { class: "oj-monitor-button", text: "保存名称", onclick: async () => {
        if (!nameInput.value.trim()) return;
        await updateGroups(this.config.groups.map((item) => item.id === group.id ? { ...item, name: nameInput.value.trim(), updatedAt: Date.now() } : item));
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "上移", disabled: groupIndex === 0, onclick: async () => {
        const groups = [...this.config.groups]; [groups[groupIndex - 1], groups[groupIndex]] = [groups[groupIndex], groups[groupIndex - 1]];
        await updateGroups(groups.map((item, index) => ({ ...item, sortOrder: index })));
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "下移", disabled: groupIndex === this.config.groups.length - 1, onclick: async () => {
        const groups = [...this.config.groups]; [groups[groupIndex], groups[groupIndex + 1]] = [groups[groupIndex + 1], groups[groupIndex]];
        await updateGroups(groups.map((item, index) => ({ ...item, sortOrder: index })));
      } }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-danger", text: "删除分组", onclick: async () => {
        if (this.global.confirm?.(`删除分组“${group.name}”及其本地缓存？`)) {
          for (const account of group.accounts) await this.store.removeAccount(account.id);
          await updateGroups(this.config.groups.filter((item) => item.id !== group.id));
        }
      } })
    ]));
    for (const account of group.accounts) container.append(this.renderAccountEditor(group, account));
    container.append(this.renderAddAccount(group));
    return container;
  }

  renderAccountEditor(group, account) {
    const username = element(this.document, "input", { class: "oj-monitor-input", value: account.username, "aria-label": accountIdentifierLabel(account.judge) });
    const enabled = element(this.document, "input", { type: "checkbox", checked: account.enabled });
    const problemset = element(this.document, "input", { type: "checkbox", checked: account.scopes?.problemset !== false });
    const gym = element(this.document, "input", { type: "checkbox", checked: account.scopes?.gym !== false });
    const row = element(this.document, "div", { class: "oj-monitor-account oj-monitor-row" }, [
      element(this.document, "strong", { text: JUDGE_LABELS[account.judge] }), username,
      element(this.document, "label", {}, [enabled, " 启用"])
    ]);
    if (account.judge === "codeforces") row.append(element(this.document, "label", {}, [problemset, " Problemset"]), element(this.document, "label", {}, [gym, " Gym"]));
    row.append(
      element(this.document, "button", { class: "oj-monitor-button", text: "保存", onclick: async () => {
        const nextUsername = username.value.trim();
        const updated = { ...account, username: nextUsername, enabled: enabled.checked };
        if (account.judge === "codeforces") updated.scopes = { problemset: problemset.checked, gym: gym.checked };
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: item.accounts.map((entry) => entry.id === account.id ? updated : entry), updatedAt: Date.now() } : item);
        if (accountUsernameChanged(account, nextUsername)) await this.store.removeAccount(account.id);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "测试用户", onclick: async (event) => {
        event.target.disabled = true; event.target.textContent = "测试中…";
        const result = await this.service.validateAccount({ ...account, username: username.value.trim() });
        event.target.disabled = false; event.target.textContent = STATUS_LABELS[result.status] || result.status;
      } }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-danger", text: "删除", onclick: async () => {
        if (!this.global.confirm?.(`删除 ${JUDGE_LABELS[account.judge]} 账号 ${account.username}？`)) return;
        await this.store.removeAccount(account.id);
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: item.accounts.filter((entry) => entry.id !== account.id) } : item);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } })
    );
    return row;
  }

  renderAddAccount(group) {
    const judge = element(this.document, "select", { class: "oj-monitor-select" }, Object.entries(JUDGE_LABELS).map(([id, label]) => option(this.document, id, label)));
    const username = element(this.document, "input", { class: "oj-monitor-input", placeholder: "用户名；牛客可填竞赛用户名或数字 UID" });
    return element(this.document, "div", { class: "oj-monitor-account oj-monitor-row" }, [
      judge, username,
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "添加网站账号", onclick: async () => {
        if (!username.value.trim()) return;
        const account = { id: createId("account"), judge: judge.value, username: username.value.trim(), enabled: true, sortOrder: group.accounts.length };
        if (judge.value === "codeforces") account.scopes = { problemset: true, gym: true };
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: [...item.accounts, account], updatedAt: Date.now() } : item);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } })
    ]);
  }

  showDiagnostics() {
    const text = this.service.diagnostics.export();
    const modal = element(this.document, "section", { class: "oj-monitor-settings" }, [
      element(this.document, "div", { class: "oj-monitor-settings-head" }, [
        element(this.document, "h2", { text: "脱敏诊断日志" }),
        element(this.document, "button", { class: "oj-monitor-button", text: "复制", onclick: async () => { await this.global.navigator?.clipboard?.writeText(text); } }),
        element(this.document, "button", { class: "oj-monitor-button", text: "关闭", onclick: () => modal.remove() })
      ]),
      element(this.document, "pre", { text })
    ]);
    this.root.querySelector(".oj-monitor-shell").append(modal);
  }
}

module.exports = { CSS, JUDGE_LABELS, MonitorPanel, STATUS_LABELS, accountIdentifierLabel, accountUsernameChanged, cellText, displayCoverageStatus, element, sharedRefreshNotice, sourceIssueText, verdictText };

},
"src/view-model.js": function(module, exports, __require) {
"use strict";

const { combineStatus } = __require("src/core.js");

const SOURCE_FILTERS = Object.freeze([
  { id: "all", label: "全部网站" },
  { id: "codeforces", label: "Codeforces 合计" },
  { id: "codeforces:problemset", label: "CF Problemset" },
  { id: "codeforces:gym", label: "CF Gym" },
  { id: "atcoder", label: "AtCoder" },
  { id: "vjudge", label: "VJudge" },
  { id: "luogu", label: "洛谷" },
  { id: "nowcoder", label: "牛客" },
  { id: "qoj", label: "QOJ" }
]);

const HEATMAP_LEVELS = Object.freeze({
  solved: Object.freeze([
    Object.freeze({ max: 0, label: "0" }),
    Object.freeze({ max: 1, label: "1" }),
    Object.freeze({ max: 3, label: "2–3" }),
    Object.freeze({ max: 6, label: "4–6" }),
    Object.freeze({ max: Infinity, label: "≥7" })
  ]),
  submissions: Object.freeze([
    Object.freeze({ max: 0, label: "0" }),
    Object.freeze({ max: 2, label: "1–2" }),
    Object.freeze({ max: 5, label: "3–5" }),
    Object.freeze({ max: 9, label: "6–9" }),
    Object.freeze({ max: Infinity, label: "≥10" })
  ])
});

function matchesSource(stat, filter = "all") {
  if (filter === "all") return true;
  const [judge, scope] = filter.split(":");
  return stat.judge === judge && (!scope || stat.scope === scope);
}

function levelFor(value, metric = "solved") {
  const number = Number(value || 0);
  const levels = HEATMAP_LEVELS[metric === "submissions" ? "submissions" : "solved"];
  return Math.max(0, levels.findIndex((level) => number <= level.max));
}

function levelLabelsFor(metric = "solved") {
  return HEATMAP_LEVELS[metric === "submissions" ? "submissions" : "solved"].map((level) => level.label);
}

function combineDaily(stats, groupId, date, source = "all") {
  const selected = stats.filter((item) => item.groupId === groupId && item.date === date && matchesSource(item, source));
  return selected.reduce((summary, item) => {
    summary.submissionCount += Number(item.submissionCount || 0);
    summary.solvedCount += Number(item.solvedCount || 0);
    summary.excludedCount += Number(item.excludedCount || 0);
    summary.status = combineStatus(summary.status, item.status);
    summary.coverageComplete &&= item.coverageComplete !== false;
    return summary;
  }, { groupId, date, submissionCount: 0, solvedCount: 0, excludedCount: 0, status: "ok", coverageComplete: true });
}

function buildHeatmapSeries(stats, groups, dateKeys, options = {}) {
  const metric = options.metric === "submissions" ? "submissions" : "solved";
  return groups.map((group) => ({
    groupId: group.id,
    name: group.name,
    days: dateKeys.map((date) => {
      const combined = combineDaily(stats, group.id, date, options.source || "all");
      const value = metric === "submissions" ? combined.submissionCount : combined.solvedCount;
      return { ...combined, value, level: levelFor(value, metric) };
    })
  }));
}

function sourceCell(stats, groupId, date, judge, scope = undefined) {
  const filter = scope ? `${judge}:${scope}` : judge;
  return combineDaily(stats, groupId, date, filter);
}

function buildDailyRows(stats, groupId, dateKeys) {
  return [...dateKeys].reverse().map((date) => ({
    date,
    problemset: sourceCell(stats, groupId, date, "codeforces", "problemset"),
    gym: sourceCell(stats, groupId, date, "codeforces", "gym"),
    atcoder: sourceCell(stats, groupId, date, "atcoder"),
    vjudge: sourceCell(stats, groupId, date, "vjudge"),
    luogu: sourceCell(stats, groupId, date, "luogu"),
    nowcoder: sourceCell(stats, groupId, date, "nowcoder"),
    qoj: sourceCell(stats, groupId, date, "qoj"),
    total: combineDaily(stats, groupId, date, "all")
  }));
}

function buildGroupRows(stats, groups, dateKeys, source = "all") {
  return groups.map((group) => {
    const totals = dateKeys.map((date) => combineDaily(stats, group.id, date, source));
    return totals.reduce((row, day) => {
      row.submissionCount += day.submissionCount;
      row.solvedCount += day.solvedCount;
      row.excludedCount += day.excludedCount;
      row.status = combineStatus(row.status, day.status);
      row.coverageComplete &&= day.coverageComplete;
      return row;
    }, { groupId: group.id, name: group.name, submissionCount: 0, solvedCount: 0, excludedCount: 0, status: "ok", coverageComplete: true });
  });
}

function filterSubmissions(submissions, groupId, date, timeZone, source = "all", zonedDateKey) {
  return submissions
    .filter((item) => item.groupId === groupId && matchesSource(item, source) && zonedDateKey(item.submittedAt, timeZone) === date)
    .sort((left, right) => right.submittedAt - left.submittedAt);
}

module.exports = {
  SOURCE_FILTERS,
  HEATMAP_LEVELS,
  buildDailyRows,
  buildGroupRows,
  buildHeatmapSeries,
  combineDaily,
  filterSubmissions,
  levelFor,
  levelLabelsFor,
  matchesSource,
  sourceCell
};

}
  };
  const __cache = Object.create(null);
  function __require(id) {
    if (__cache[id]) return __cache[id].exports;
    const factory = __modules[id];
    if (!factory) throw new Error("Unknown bundled module: " + id);
    const module = { exports: {} };
    __cache[id] = module;
    factory(module, module.exports, __require);
    return module.exports;
  }
  const api = __require("src/main.js");
  Object.defineProperty(global, "OJMonitor", { value: api, configurable: true });
})(typeof globalThis !== "undefined" ? globalThis : window);
