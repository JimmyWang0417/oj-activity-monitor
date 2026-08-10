"use strict";

const { combineStatus } = require("./core");

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
