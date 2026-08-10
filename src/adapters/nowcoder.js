"use strict";

const { OJMonitorError } = require("../core");
const { failureResult, makeResult, validationFailure } = require("./common");

const BASE = "https://ac.nowcoder.com";
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = null;
const RATING_PATH = "/acm/contest/rating-index";
const USERNAME_MAX_LENGTH = 64;
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;

function decodeHtml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hexadecimal) => String.fromCodePoint(Number.parseInt(hexadecimal, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);|&apos;/gi, "'");
}

function stripHtml(value) {
  return decodeHtml(String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributeValue(openingTag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeHtml(openingTag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] || "");
}

function extractCells(rowHtml, tagName) {
  const expression = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  return [...String(rowHtml).matchAll(expression)].map((match) => match[1]);
}

function anchors(cellHtml) {
  return [...String(cellHtml).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    href: attributeValue(match[1], "href"),
    label: stripHtml(match[2])
  }));
}

function normalizeHeader(value) {
  return stripHtml(value).replace(/[\s_：:()（）-]+/g, "");
}

function headerKind(value) {
  const header = normalizeHeader(value);
  if (header === "运行ID") return "id";
  if (header === "题目") return "problem";
  if (header === "运行结果") return "result";
  if (header === "提交时间") return "submitTime";
  return undefined;
}

function assertUid(uid) {
  if (!/^[1-9]\d{0,17}$/.test(String(uid))) {
    throw new OJMonitorError("not-found", "牛客账号必须是 1 至 18 位正整数 UID");
  }
}

function normalizeIdentifier(value) {
  return String(value ?? "").trim();
}

function foldedUsername(value) {
  return normalizeIdentifier(value).toLocaleLowerCase("en-US");
}

function assertUsername(username) {
  const value = normalizeIdentifier(username);
  if (!value || value.length > USERNAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new OJMonitorError("not-found", `牛客竞赛用户名必须是 1 至 ${USERNAME_MAX_LENGTH} 个可见字符`);
  }
  return value;
}

function practicePath(uid) {
  return `/acm/contest/profile/${uid}/practice-coding`;
}

function parsePageIdentity(html) {
  return String(html).match(/window\.curUser\.id\s*=\s*["'](\d+)["']/i)?.[1] || "";
}

function parseDisplayName(html) {
  const source = String(html);
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/\bcoder-name\b/i.test(attributeValue(match[1], "class"))) continue;
    return attributeValue(match[1], "data-title") || stripHtml(match[2]) || undefined;
  }
  return undefined;
}

function assertRatingPage(response, identifier, requestedUrl) {
  const finalUrl = String(response?.finalUrl || requestedUrl || "");
  let parsed;
  try {
    parsed = new URL(finalUrl, BASE);
  } catch {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索返回了无效地址");
  }
  if (parsed.origin !== BASE || parsed.pathname.replace(/\/$/, "") !== RATING_PATH) {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索被重定向到未知页面", { finalUrl: parsed.href });
  }
  if (parsed.searchParams.get("searchUserName") !== identifier) {
    throw new OJMonitorError("schema-changed", "牛客 Rating 搜索没有保留目标用户名", { finalUrl: parsed.href });
  }
  return parsed.href;
}

function assertPracticePage(response, uid, requestedUrl) {
  const finalUrl = String(response?.finalUrl || requestedUrl || "");
  let parsed;
  try {
    parsed = new URL(finalUrl, BASE);
  } catch {
    throw new OJMonitorError("schema-changed", "牛客练习页返回了无效地址");
  }
  const actualPath = parsed.pathname.replace(/\/$/, "") || "/";
  if (parsed.origin !== BASE || actualPath !== practicePath(uid)) {
    throw new OJMonitorError("not-found", "牛客 UID 不存在或练习页被重定向", { finalUrl: parsed.href });
  }
  const identity = parsePageIdentity(response?.text);
  if (!identity && /页面找不到了/.test(String(response?.text || ""))) {
    throw new OJMonitorError("not-found", "牛客 UID 不存在", { finalUrl: parsed.href });
  }
  if (!identity) throw new OJMonitorError("schema-changed", "牛客练习页缺少用户身份");
  if (identity !== String(uid)) {
    throw new OJMonitorError("schema-changed", `牛客练习页身份不匹配：期望 ${uid}，实际为 ${identity}`);
  }
  return { identity, displayName: parseDisplayName(response?.text), finalUrl: parsed.href };
}

// The public page renders a timezone-less wall-clock value. NowCoder does not
// expose an offset in this HTML contract, so the adapter explicitly assumes UTC+8.
function parseNowcoderTime(value) {
  const text = stripHtml(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`);
}

function isAcceptedNowcoderVerdict(value) {
  return stripHtml(value) === "答案正确";
}

function parseSubmissionTotal(html) {
  const source = String(html);
  const starts = [...source.matchAll(/<div\b[^>]*class=["'][^"']*\bmy-state-item\b[^"']*["'][^>]*>/gi)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index;
    const end = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    if (!/次提交/.test(stripHtml(block))) continue;
    const value = block.match(/<div\b[^>]*class=["'][^"']*\bstate-num\b[^"']*["'][^>]*>\s*(\d+)\s*<\/div>/i)?.[1];
    if (value !== undefined) return Number(value);
  }
  return null;
}

function ratingHeaderKind(value) {
  const header = normalizeHeader(value);
  if (header === "Rating排名") return "rank";
  if (header === "用户名") return "username";
  if (header === "Rating") return "rating";
  return undefined;
}

function parseNowcoderRatingHtml(html, identifier) {
  const source = String(html);
  const requested = assertUsername(identifier);
  const requiredColumns = ["rank", "username", "rating"];
  let rows;
  let columnIndex;
  for (const table of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const candidateRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
    for (const headerRow of candidateRows.filter((row) => /<th\b/i.test(row))) {
      const candidateIndex = {};
      extractCells(headerRow, "th").forEach((header, index) => {
        const kind = ratingHeaderKind(header);
        if (kind && candidateIndex[kind] === undefined) candidateIndex[kind] = index;
      });
      if (requiredColumns.every((required) => candidateIndex[required] !== undefined)) {
        rows = candidateRows;
        columnIndex = candidateIndex;
        break;
      }
    }
    if (rows) break;
  }
  if (!rows) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索缺少完整语义表头");

  const requiredCellCount = Math.max(...Object.values(columnIndex)) + 1;
  const candidates = [];
  for (const row of rows) {
    const cells = extractCells(row, "td");
    if (!cells.length || cells.length < requiredCellCount) continue;
    let sawProfileLink = false;
    for (const match of String(cells[columnIndex.username]).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      let candidate;
      try {
        candidate = new URL(attributeValue(match[1], "href"), BASE);
      } catch {
        continue;
      }
      const profile = candidate.pathname.match(/^\/acm\/contest\/profile\/(\d+)$/);
      if (candidate.origin !== BASE || !profile) continue;
      sawProfileLink = true;
      assertUid(profile[1]);
      const withoutControls = match[2].replace(/<button\b[\s\S]*?<\/button>/gi, " ");
      const canonicalName = stripHtml(withoutControls);
      if (!canonicalName) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索结果缺少规范用户名");
      candidates.push({ uid: profile[1], canonicalName });
    }
    if (!sawProfileLink) throw new OJMonitorError("schema-changed", "牛客 Rating 搜索存在无法识别的用户行");
  }

  const matches = candidates.filter((candidate) => foldedUsername(candidate.canonicalName) === foldedUsername(requested));
  const unique = new Map(matches.map((candidate) => [candidate.uid, candidate]));
  if (!unique.size) throw new OJMonitorError("not-found", `牛客 Rating 搜索未找到竞赛用户名 ${requested}，请改填数字 UID`);
  if (unique.size > 1) throw new OJMonitorError("not-found", `牛客竞赛用户名 ${requested} 对应多个 UID，请改填数字 UID`);
  return [...unique.values()][0];
}

function parseNowcoderPracticeHtml(html, options = {}) {
  const source = String(html);
  const uid = String(options.uid || options.username || "");
  assertUid(uid);
  const identity = parsePageIdentity(source);
  if (!identity) {
    if (/页面找不到了/.test(source)) throw new OJMonitorError("not-found", "牛客 UID 不存在");
    throw new OJMonitorError("schema-changed", "牛客练习页缺少用户身份");
  }
  if (identity !== uid) throw new OJMonitorError("schema-changed", `牛客练习页身份不匹配：期望 ${uid}，实际为 ${identity}`);

  const requiredColumns = ["id", "problem", "result", "submitTime"];
  let rows;
  let columnIndex;
  for (const table of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const candidateRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
    for (const headerRow of candidateRows.filter((row) => /<th\b/i.test(row))) {
      const candidateIndex = {};
      extractCells(headerRow, "th").forEach((header, index) => {
        const kind = headerKind(header);
        if (kind && candidateIndex[kind] === undefined) candidateIndex[kind] = index;
      });
      if (requiredColumns.every((required) => candidateIndex[required] !== undefined)) {
        rows = candidateRows;
        columnIndex = candidateIndex;
        break;
      }
    }
    if (rows) break;
  }
  if (!rows) throw new OJMonitorError("schema-changed", "牛客练习页缺少完整语义表头");
  const requiredCellCount = Math.max(...Object.values(columnIndex)) + 1;

  const submissions = [];
  for (const row of rows) {
    const cells = extractCells(row, "td");
    if (!cells.length) continue;
    let submission;
    for (const link of anchors(cells[columnIndex.id] || "")) {
      try {
        const candidate = new URL(link.href, BASE);
        if (candidate.origin !== BASE || candidate.pathname !== "/acm/contest/view-submission") continue;
        const submissionId = candidate.searchParams.get("submissionId") || "";
        const rowUid = candidate.searchParams.get("uid") || "";
        if (!/^\d+$/.test(submissionId)) continue;
        if (rowUid && rowUid !== uid) throw new OJMonitorError("schema-changed", `牛客提交 ${submissionId} 的 UID 不匹配`);
        submission = { submissionId };
        break;
      } catch (error) {
        if (error instanceof OJMonitorError) throw error;
      }
    }
    if (!submission) {
      if (cells.length >= requiredCellCount) throw new OJMonitorError("schema-changed", "牛客练习页存在无法识别运行 ID 的提交行");
      continue;
    }

    let problem;
    for (const link of anchors(cells[columnIndex.problem] || "")) {
      try {
        const candidate = new URL(link.href, BASE);
        const match = candidate.pathname.match(/^\/acm\/problem\/(\d+)$/);
        if (candidate.origin !== BASE || !match) continue;
        problem = { id: match[1], name: link.label, url: candidate.href };
        break;
      } catch {
        // Ignore unrelated or malformed links and fail below if none is usable.
      }
    }
    if (!problem) throw new OJMonitorError("schema-changed", `牛客提交 ${submission.submissionId} 缺少可识别题目链接`);
    const submittedAt = parseNowcoderTime(cells[columnIndex.submitTime]);
    if (!Number.isFinite(submittedAt)) throw new OJMonitorError("schema-changed", `牛客提交 ${submission.submissionId} 的提交时间无法解析`);
    const verdict = stripHtml(cells[columnIndex.result]) || "UNKNOWN";
    submissions.push({
      groupId: options.groupId,
      accountId: options.accountId,
      judge: "nowcoder",
      scope: "default",
      username: options.recordUsername || uid,
      submissionId: submission.submissionId,
      problemKey: `nowcoder:${problem.id}`,
      problemName: problem.name || undefined,
      problemUrl: problem.url,
      submittedAt,
      verdict,
      accepted: isAcceptedNowcoderVerdict(verdict)
    });
  }

  const officialEmpty = /没有找到你想要的内容呢/.test(stripHtml(source));
  const submissionTotal = parseSubmissionTotal(source);
  if (!submissions.length && !officialEmpty && submissionTotal !== 0) {
    throw new OJMonitorError("schema-changed", "牛客练习页没有可解析提交，也没有可信空结果标记");
  }
  const currentPage = Number(options.page || 1);
  const totalText = source.match(/<ul\b[^>]*\bdata-total=["'](\d+)["']/i)?.[1];
  const totalPages = totalText === undefined ? null : Number(totalText);
  const decoded = decodeHtml(source);
  const hasNext = [...decoded.matchAll(/href=["']([^"']+)["']/gi)].some((match) => {
    try {
      const candidate = new URL(match[1], `${BASE}${practicePath(uid)}`);
      return candidate.pathname === practicePath(uid)
        && Number(candidate.searchParams.get("page")) === currentPage + 1;
    } catch {
      return false;
    }
  });
  return {
    submissions,
    hasNext,
    totalPages,
    explicitEmpty: !submissions.length && (officialEmpty || submissionTotal === 0),
    signature: submissions.map((item) => item.submissionId).join(","),
    displayName: parseDisplayName(source)
  };
}

class NowcoderAdapter {
  constructor(options) {
    this.id = "nowcoder";
    this.displayName = "牛客";
    this.client = options.client;
    this.limiter = options.limiter;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.clock = options.clock || (() => Date.now());
    this.resolutionCacheTtlMs = options.resolutionCacheTtlMs ?? RESOLUTION_CACHE_TTL_MS;
    this.resolutionCache = new Map();
  }

  ratingSearchUrl(identifier) {
    const query = new URLSearchParams({
      onlyMyFollow: "false",
      page: "1",
      pageSize: "50",
      searchUserName: identifier
    });
    return `${BASE}${RATING_PATH}?${query}`;
  }

  pageUrl(uid, page) {
    const query = new URLSearchParams({
      pageSize: String(PAGE_SIZE),
      search: "",
      statusTypeFilter: "-1",
      languageCategoryFilter: "-1",
      orderType: "DESC",
      page: String(page)
    });
    return `${BASE}${practicePath(uid)}?${query}`;
  }

  async requestPage(uid, page, signal) {
    const url = this.pageUrl(uid, page);
    await this.limiter?.waitTurn("ac.nowcoder.com", 1000);
    const response = await this.client.request(url, { signal });
    assertPracticePage(response, uid, url);
    return response;
  }

  async resolveUsername(identifier, signal) {
    const url = this.ratingSearchUrl(identifier);
    await this.limiter?.waitTurn("ac.nowcoder.com", 1000);
    const response = await this.client.request(url, { signal });
    assertRatingPage(response, identifier, url);
    return parseNowcoderRatingHtml(response.text, identifier);
  }

  async resolveIdentifier(value, options = {}) {
    const identifier = normalizeIdentifier(value);
    if (/^\d+$/.test(identifier)) {
      assertUid(identifier);
      return { uid: identifier, canonicalName: undefined, source: "uid" };
    }
    assertUsername(identifier);
    const key = foldedUsername(identifier);
    const cached = this.resolutionCache.get(key);
    const now = this.clock();
    if (cached && now - cached.at < this.resolutionCacheTtlMs) {
      return cached.value || cached.promise;
    }
    const promise = this.resolveUsername(identifier, options.signal);
    this.resolutionCache.set(key, { at: now, promise });
    try {
      const value = await promise;
      this.resolutionCache.set(key, { at: this.clock(), value });
      return value;
    } catch (error) {
      this.resolutionCache.delete(key);
      throw error;
    }
  }

  assertResolvedDisplay(resolution, displayName) {
    if (!resolution.canonicalName) return;
    if (!displayName || foldedUsername(displayName) !== foldedUsername(resolution.canonicalName)) {
      throw new OJMonitorError("schema-changed", "牛客 Rating 搜索结果与练习页用户名不匹配");
    }
  }

  async validateUser(username, options = {}) {
    try {
      const resolution = await this.resolveIdentifier(username, options);
      const response = await this.requestPage(resolution.uid, 1, options.signal);
      const parsed = parseNowcoderPracticeHtml(response.text, { uid: resolution.uid, username: resolution.uid, page: 1 });
      this.assertResolvedDisplay(resolution, parsed.displayName);
      return {
        exists: true,
        canonicalUsername: resolution.uid,
        displayName: parsed.displayName || resolution.canonicalName,
        status: "ok"
      };
    } catch (error) {
      if (error.status === "not-found") return { exists: false, status: "not-found", message: error.message };
      return validationFailure(error);
    }
  }

  async fetchSubmissions(options) {
    const submissions = [];
    const signatures = new Set();
    const seenIds = new Set();
    let pagesFetched = 0;
    let previousOldest = Infinity;
    let stopReason = "unknown";
    let resolution;
    let resultOptions = options;
    try {
      resolution = await this.resolveIdentifier(options.username, { signal: options.signal });
      const recordUsername = resolution.canonicalName || resolution.uid;
      resultOptions = { ...options, username: recordUsername };
      for (let page = 1; ; page += 1) {
        if (this.maxPages !== null && page > this.maxPages) {
          stopReason = "page-limit";
          break;
        }
        const response = await this.requestPage(resolution.uid, page, options.signal);
        const parsed = parseNowcoderPracticeHtml(response.text, {
          ...options,
          uid: resolution.uid,
          username: resolution.uid,
          recordUsername,
          page
        });
        this.assertResolvedDisplay(resolution, parsed.displayName);
        pagesFetched += 1;
        if (parsed.explicitEmpty) {
          stopReason = "empty-page";
          break;
        }
        if (signatures.has(parsed.signature)) {
          stopReason = "repeated-page";
          break;
        }
        signatures.add(parsed.signature);
        if (parsed.submissions.some((item) => seenIds.has(item.submissionId))) {
          stopReason = "overlapping-page";
          break;
        }

        let previous = Infinity;
        let newest = -Infinity;
        for (const submission of parsed.submissions) {
          if (submission.submittedAt > previous) throw new OJMonitorError("schema-changed", "牛客提交不再按时间倒序排列");
          previous = submission.submittedAt;
          newest = Math.max(newest, submission.submittedAt);
          seenIds.add(submission.submissionId);
          if (submission.submittedAt >= options.from && submission.submittedAt <= options.to) submissions.push(submission);
        }
        const oldest = Math.min(...parsed.submissions.map((item) => item.submittedAt));
        if (newest > previousOldest) throw new OJMonitorError("schema-changed", "牛客跨页提交时间回跳，无法证明分页完整");
        previousOldest = oldest;
        if (oldest < options.from) {
          stopReason = "reached-from";
          break;
        }
        if (parsed.totalPages !== null) {
          if (page > parsed.totalPages) throw new OJMonitorError("schema-changed", "牛客当前页超过页面声明的总页数");
          if (page >= parsed.totalPages) {
            stopReason = "last-page";
            break;
          }
          if (!parsed.hasNext) throw new OJMonitorError("schema-changed", "牛客分页声明仍有后页，但缺少下一页链接");
        } else if (!parsed.hasNext) {
          if (parsed.submissions.length >= PAGE_SIZE) {
            stopReason = "missing-pagination";
            break;
          }
          stopReason = "last-page";
          break;
        }
      }
      const complete = ["reached-from", "empty-page", "last-page"].includes(stopReason);
      const warnings = {
        "page-limit": `牛客分页达到配置的 ${this.maxPages} 页上限`,
        "repeated-page": "牛客返回重复分页，无法证明完整覆盖",
        "overlapping-page": "牛客相邻分页包含重复提交，无法证明完整覆盖",
        "missing-pagination": "牛客返回满页数据但缺少分页证据"
      };
      return makeResult(resultOptions, {
        judge: "nowcoder",
        scope: "default",
        status: complete ? "ok" : "partial",
        complete,
        submissions,
        reason: complete ? undefined : stopReason,
        warning: warnings[stopReason],
        diagnostics: { stopReason, pagesFetched, source: "nowcoder-practice-coding-html", resolvedUid: resolution.uid }
      });
    } catch (error) {
      return failureResult(resultOptions, "nowcoder", "default", error, {
        submissions,
        diagnostics: { stopReason: error.status || "request-error", pagesFetched, source: "nowcoder-practice-coding-html", resolvedUid: resolution?.uid }
      });
    }
  }
}

module.exports = {
  BASE,
  DEFAULT_MAX_PAGES,
  NowcoderAdapter,
  PAGE_SIZE,
  RESOLUTION_CACHE_TTL_MS,
  RATING_PATH,
  USERNAME_MAX_LENGTH,
  assertPracticePage,
  assertRatingPage,
  assertUid,
  foldedUsername,
  isAcceptedNowcoderVerdict,
  parseNowcoderPracticeHtml,
  parseNowcoderRatingHtml,
  parseNowcoderTime
};
