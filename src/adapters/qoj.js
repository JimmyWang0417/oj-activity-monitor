"use strict";

const { OJMonitorError } = require("../core");
const { isSameOrigin, pageTransportAvailable } = require("../request");
const { failureResult, makeResult, validationFailure } = require("./common");

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

function parseQojSubmissionsHtml(html, options = {}) {
  const source = String(html);
  if (/<form\b[^>]*(?:action=["']\/login|id=["']form-login)/i.test(source) || /href=["']\/login["'][^>]*>\s*(?:login|登录)/i.test(source) && !/<table\b/i.test(source)) {
    throw new OJMonitorError("login-required", "请先登录 QOJ");
  }
  const rows = [...source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const headerRow = rows.find((row) => /<th\b/i.test(row));
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
    const submitter = stripHtml(cells[columnIndex.submitter]);
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
  parseQojTime,
  qojFailureWarning,
  stripHtml
};
