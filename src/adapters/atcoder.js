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
