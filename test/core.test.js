"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateDaily,
  classifyCodeforcesContest,
  inferAccepted,
  mergeSubmissions,
  normalizeConfig,
  parseCodeforcesProblemUrl,
  recentDateKeys,
  summarizeGroup,
  zonedDateKey
} = require("../src/core");

function submission(overrides = {}) {
  return {
    groupId: "g1",
    accountId: "a1",
    judge: "codeforces",
    scope: "problemset",
    username: "tourist",
    submissionId: "1",
    problemKey: "codeforces:problemset:1:A",
    submittedAt: Date.parse("2026-08-06T16:30:00Z"),
    verdict: "OK",
    accepted: true,
    ...overrides
  };
}

test("Codeforces URL parsing keeps Gym and Problemset separate", () => {
  assert.deepEqual(parseCodeforcesProblemUrl("https://codeforces.com/gym/105001/problem/B"), {
    scope: "gym",
    contestId: "105001",
    index: "B",
    problemKey: "codeforces:gym:105001:B",
    canonicalUrl: "https://codeforces.com/gym/105001/problem/B"
  });
  assert.equal(parseCodeforcesProblemUrl("/contest/2030/problem/A").scope, "problemset");
  assert.equal(parseCodeforcesProblemUrl("/problemset/problem/2030/A").problemKey, "codeforces:problemset:2030:A");
  assert.equal(parseCodeforcesProblemUrl("/blog/entry/1"), null);
});

test("Codeforces authority sets classify API records without numeric heuristics", () => {
  const regularContestIds = new Set([1, 100001]);
  const gymContestIds = new Set([100001, 105001]);
  assert.equal(classifyCodeforcesContest({ contestId: 1, gymContestIds, regularContestIds }), "problemset");
  assert.equal(classifyCodeforcesContest({ contestId: 105001, gymContestIds, regularContestIds }), "gym");
  assert.equal(classifyCodeforcesContest({ contestId: 999, gymContestIds, regularContestIds }), "unsupported");
  assert.equal(classifyCodeforcesContest({ contestId: 1, url: "/gym/1/problem/A", gymContestIds, regularContestIds }), "gym");
});

test("submission merge deduplicates by account, judge, scope and submission id", () => {
  const merged = mergeSubmissions(
    [submission({ problemName: "old" })],
    [submission({ problemName: "new" }), submission({ submissionId: "2", accepted: false })]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].problemName, "new");
});

test("daily aggregation uses configured timezone and distinct accepted problem keys", () => {
  const now = Date.parse("2026-08-07T10:00:00+08:00");
  const results = [{
    groupId: "g1", accountId: "a1", judge: "codeforces", scope: "problemset",
    status: "ok", excludedCount: 3, coverage: { complete: true }, updatedAt: now
  }];
  const stats = aggregateDaily([
    submission(),
    submission({ submissionId: "2" }),
    submission({ submissionId: "3", problemKey: "codeforces:problemset:1:B", accepted: false })
  ], results, { days: 2, now, timeZone: "Asia/Shanghai" });
  const august7 = stats.find((item) => item.date === "2026-08-07");
  assert.equal(august7.submissionCount, 3);
  assert.equal(august7.solvedCount, 1);
  assert.equal(stats.reduce((sum, item) => sum + item.excludedCount, 0), 3);
  assert.deepEqual(summarizeGroup(stats, "g1", recentDateKeys(2, now, "Asia/Shanghai")), {
    groupId: "g1", submissionCount: 3, solvedCount: 1, excludedCount: 3, status: "ok", coverageComplete: true
  });
  assert.equal(zonedDateKey(Date.parse("2026-08-06T16:30:00Z"), "Asia/Shanghai"), "2026-08-07");
});

test("incomplete coverage preserves actionable source errors instead of flattening them to partial", () => {
  const stats = aggregateDaily([], [{ groupId: "g1", accountId: "a1", judge: "luogu", scope: "default", status: "login-required", coverage: { complete: false } }], { days: 1, now: Date.parse("2026-08-07T00:00:00Z") });
  assert.equal(stats[0].status, "login-required");
  assert.equal(stats[0].coverageComplete, false);
});

test("QOJ is a first-class default-scope judge in config and submissions", () => {
  const { normalizeAccount, normalizeSubmission } = require("../src/core");
  assert.deepEqual(normalizeAccount({ id: "q", judge: "qoj", username: "alice" }), {
    id: "q", judge: "qoj", username: "alice", enabled: true, sortOrder: 0
  });
  const submission = normalizeSubmission({
    groupId: "g", accountId: "q", judge: "qoj", username: "alice", submissionId: "1",
    problemKey: "qoj:1", submittedAt: 1, verdict: "100", accepted: true
  });
  assert.equal(submission.scope, "default");
});

test("NowCoder is a first-class default-scope judge and recovers its exact legacy verdict", () => {
  const { normalizeAccount, normalizeSubmission } = require("../src/core");
  assert.deepEqual(normalizeAccount({ id: "n", judge: "nowcoder", username: "123456789" }), {
    id: "n", judge: "nowcoder", username: "123456789", enabled: true, sortOrder: 0
  });
  const item = normalizeSubmission({
    groupId: "g", accountId: "n", judge: "nowcoder", username: "123456789", submissionId: "1",
    problemKey: "nowcoder:2", submittedAt: 1, verdict: "答案正确", accepted: false
  });
  assert.equal(item.scope, "default");
  assert.equal(item.accepted, true);
  assert.equal(inferAccepted("nowcoder", "答案错误", false), false);
});

test("legacy QOJ and Luogu cache entries recover accepted status from verdict text", () => {
  assert.equal(inferAccepted("qoj", "AC ✓", false), true);
  assert.equal(inferAccepted("qoj", "100.0", false), true);
  assert.equal(inferAccepted("qoj", "0", false), false);
  assert.equal(inferAccepted("luogu", "recordStatus:12", false), true);
  assert.equal(inferAccepted("luogu", "recordStatus:14", false), false);
});

test("config normalization preserves Codeforces per-scope switches", () => {
  const config = normalizeConfig({ groups: [{ name: "Alice", accounts: [{ judge: "codeforces", username: "alice", scopes: { gym: false } }] }], settings: { days: 14 } });
  assert.equal(config.groups[0].name, "Alice");
  assert.deepEqual(config.groups[0].accounts[0].scopes, { problemset: true, gym: false });
  assert.equal(config.settings.days, 14);
});
