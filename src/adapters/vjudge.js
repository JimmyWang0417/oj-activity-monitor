"use strict";

const { OJMonitorError } = require("../core");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = require("./common");

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
