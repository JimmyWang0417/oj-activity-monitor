"use strict";

const {
  OJMonitorError,
  classifyCodeforcesContest,
  mergeSubmissions,
  parseCodeforcesProblemUrl
} = require("../core");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = require("./common");

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
