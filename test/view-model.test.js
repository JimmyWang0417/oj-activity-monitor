"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDailyRows, buildGroupRows, buildHeatmapSeries, levelFor, levelLabelsFor } = require("../src/view-model");

const stat = (overrides = {}) => ({
  groupId: "g", accountId: "a", judge: "codeforces", scope: "problemset", date: "2026-08-07",
  submissionCount: 5, solvedCount: 2, excludedCount: 0, status: "ok", coverageComplete: true,
  ...overrides
});

test("heatmap view model filters Codeforces scopes and uses shared thresholds", () => {
  const stats = [stat(), stat({ scope: "gym", submissionCount: 4, solvedCount: 1 })];
  const problemset = buildHeatmapSeries(stats, [{ id: "g", name: "Alice" }], ["2026-08-07"], { source: "codeforces:problemset", metric: "solved" });
  assert.equal(problemset[0].days[0].value, 2);
  assert.equal(problemset[0].days[0].level, 2);
  assert.deepEqual([0, 1, 2, 3, 4, 6, 7].map((value) => levelFor(value, "solved")), [0, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 5, 6, 9, 10].map((value) => levelFor(value, "submissions")), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual(levelLabelsFor("solved"), ["0", "1", "2–3", "4–6", "≥7"]);
  assert.deepEqual(levelLabelsFor("submissions"), ["0", "1–2", "3–5", "6–9", "≥10"]);
});

test("daily rows keep QOJ separate while including it in totals", () => {
  const stats = [stat({ judge: "qoj", scope: "default", submissionCount: 4, solvedCount: 3 })];
  const row = buildDailyRows(stats, "g", ["2026-08-07"])[0];
  assert.equal(row.qoj.submissionCount, 4);
  assert.equal(row.qoj.solvedCount, 3);
  assert.equal(row.total.submissionCount, 4);
});

test("daily and group rows preserve partial lower-bound state", () => {
  const stats = [stat(), stat({ judge: "atcoder", scope: "default", accountId: "b", submissionCount: 3, solvedCount: 1, status: "partial", coverageComplete: false })];
  const daily = buildDailyRows(stats, "g", ["2026-08-07"])[0];
  assert.equal(daily.total.submissionCount, 8);
  assert.equal(daily.total.coverageComplete, false);
  const groups = buildGroupRows(stats, [{ id: "g", name: "Alice" }], ["2026-08-07"]);
  assert.deepEqual(groups[0], { groupId: "g", name: "Alice", submissionCount: 8, solvedCount: 3, excludedCount: 0, status: "partial", coverageComplete: false });
});

test("group comparison follows the same website and Codeforces scope filter as the heatmap", () => {
  const stats = [
    stat({ scope: "problemset", submissionCount: 5, solvedCount: 2 }),
    stat({ scope: "gym", accountId: "gym", submissionCount: 4, solvedCount: 1 }),
    stat({ judge: "atcoder", scope: "default", accountId: "atcoder", submissionCount: 7, solvedCount: 3, status: "partial", coverageComplete: false })
  ];
  const groups = [{ id: "g", name: "Alice" }];
  const dates = ["2026-08-07"];
  assert.deepEqual(
    buildGroupRows(stats, groups, dates, "codeforces")[0],
    { groupId: "g", name: "Alice", submissionCount: 9, solvedCount: 3, excludedCount: 0, status: "ok", coverageComplete: true }
  );
  assert.deepEqual(
    buildGroupRows(stats, groups, dates, "codeforces:gym")[0],
    { groupId: "g", name: "Alice", submissionCount: 4, solvedCount: 1, excludedCount: 0, status: "ok", coverageComplete: true }
  );
  assert.deepEqual(
    buildGroupRows(stats, groups, dates, "atcoder")[0],
    { groupId: "g", name: "Alice", submissionCount: 7, solvedCount: 3, excludedCount: 0, status: "partial", coverageComplete: false }
  );
});

test("comparison heatmaps keep ten people in ten independent rows", () => {
  const groups = Array.from({ length: 10 }, (_unused, index) => ({ id: `g${index}`, name: `Person ${index}` }));
  const stats = groups.map((group, index) => stat({ groupId: group.id, accountId: `a${index}`, solvedCount: index }));
  const series = buildHeatmapSeries(stats, groups, ["2026-08-07"], { metric: "solved" });
  assert.equal(series.length, 10);
  assert.deepEqual(series.map((row) => row.days[0].value), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
