"use strict";

const { OJMonitorError, mergeSubmissions } = require("../core");

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

function normalizeResumeBoundary(value) {
  if (!value || value.submissionId === undefined || value.submittedAt === undefined) return null;
  const submittedAt = Number(value.submittedAt);
  const submissionId = String(value.submissionId).trim();
  if (!submissionId || !Number.isFinite(submittedAt)) return null;
  return { submissionId, submittedAt };
}

function newestResumeBoundary(submissions) {
  let newest;
  for (const submission of submissions || []) {
    const candidate = normalizeResumeBoundary(submission);
    if (!candidate) continue;
    if (!newest || candidate.submittedAt > newest.submittedAt ||
      candidate.submittedAt === newest.submittedAt && candidate.submissionId > newest.submissionId) {
      newest = candidate;
    }
  }
  return newest;
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
  normalizeResumeBoundary,
  newestResumeBoundary,
  validationFailure
};
