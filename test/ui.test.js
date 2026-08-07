"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { cellText, displayCoverageStatus, sharedRefreshNotice, sourceIssueText, verdictText } = require("../src/ui");

test("proved descending coverage renders exact counts and partial coverage renders lower bounds", () => {
  assert.equal(cellText({ solvedCount: 3, submissionCount: 8, coverageComplete: true }), "3/8");
  assert.equal(cellText({ solvedCount: 3, submissionCount: 8, coverageComplete: false }), "≥3/≥8");
});

test("coverage display preserves actionable errors instead of flattening them", () => {
  assert.equal(displayCoverageStatus({ status: "login-required", coverageComplete: false }), "login-required");
  assert.equal(displayCoverageStatus({ status: "ok", coverageComplete: false }), "partial");
  assert.equal(displayCoverageStatus({ status: "ok", coverageComplete: true }), "ok");
});

test("refresh issue text exposes the concrete source warning", () => {
  const issue = sourceIssueText({
    group: { name: "Alice" },
    account: { judge: "luogu" },
    result: { status: "partial", coverage: { complete: false, reason: "page-limit" }, warning: "洛谷分页达到配置上限" }
  });
  assert.equal(issue, "Alice / 洛谷：数据可能不完整 — 洛谷分页达到配置上限");
  assert.equal(sourceIssueText({ group: {}, account: {}, result: { status: "ok", coverage: { complete: true } } }), null);
});

test("submission details mark accepted verdicts exactly once", () => {
  assert.equal(verdictText({ verdict: "AC", accepted: true }), "AC ✓");
  assert.equal(verdictText({ verdict: "AC ✓", accepted: true }), "AC ✓");
  assert.equal(verdictText({ verdict: "WA", accepted: false }), "WA");
  assert.equal(verdictText({ verdict: "recordStatus:12", accepted: true }), "recordStatus:12 ✓");
});

test("shared refresh completion replaces the waiting message", () => {
  assert.deepEqual(sharedRefreshNotice({ incompleteCount: 0 }), { text: "已读取另一个标签页完成的共享结果。", status: "ok" });
  assert.deepEqual(sharedRefreshNotice({ incompleteCount: 2 }), {
    text: "已读取另一个标签页完成的共享结果；有 2 个来源未完整覆盖，请查看每日表格状态。",
    status: "partial"
  });
});
