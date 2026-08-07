"use strict";

const { OJMonitorError, isRecord } = require("../core");
const { isSameOrigin, pageTransportCapability } = require("../request");
const {
  failureResult,
  makeResult,
  requireArray,
  requireFinite,
  requireText,
  validationFailure
} = require("./common");

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
