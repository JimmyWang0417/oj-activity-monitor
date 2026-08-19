"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AtCoderAdapter, normalizeAtCoderSubmission } = require("../src/adapters/atcoder");
const { CodeforcesAdapter, parseVisibleSubmissionHtml } = require("../src/adapters/codeforces");
const { DEFAULT_MAX_PAGES, diagnosticFinalLocation, diagnosticReason, findRecordArray, findRecordPage, LuoguAdapter, normalizeLuoguSubmission, parseLentilleContextHtml, parseLuoguContentResponse } = require("../src/adapters/luogu");
const { NowcoderAdapter, isAcceptedNowcoderVerdict, parseNowcoderPracticeHtml, parseNowcoderRatingHtml, parseNowcoderTime } = require("../src/adapters/nowcoder");
const { QojAdapter, isAcceptedQojVerdict, parseQojSubmissionsHtml, parseQojTime } = require("../src/adapters/qoj");
const { RESULT_FILTERS, VJudgeAdapter, normalizeVJudgeSubmission } = require("../src/adapters/vjudge");
const { MemoryBackend, Store } = require("../src/storage");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const textFixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const range = {
  groupId: "group", accountId: "account", username: "user", scope: "default",
  from: 0, to: Date.parse("2030-01-01T00:00:00Z")
};

const nowcoderRange = {
  groupId: "group", accountId: "nowcoder-account", username: "123456789", scope: "default",
  from: 0, to: Date.parse("2030-01-01T00:00:00Z")
};

function nowcoderClient(pages) {
  const calls = [];
  return {
    calls,
    global: {},
    request: async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      const text = typeof pages === "function" ? pages(page) : pages[page];
      return { status: 200, finalUrl: url, text };
    }
  };
}

function examplePracticeHtml(html = textFixture("nowcoder-practice-coding.html")) {
  return html
    .replaceAll("123456789", "900000000000000001")
    .replaceAll("Alice &amp; Bob", "Example_user");
}

function nowcoderIdentifierClient(ratingHtml, pages) {
  const calls = [];
  return {
    calls,
    global: {},
    request: async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      const text = parsed.pathname === "/acm/contest/rating-index"
        ? ratingHtml
        : pages[Number(parsed.searchParams.get("page"))];
      return { status: 200, finalUrl: url, text };
    }
  };
}

test("Codeforces mixed API fixture splits into authoritative Problemset and Gym channels", () => {
  const adapter = new CodeforcesAdapter({ client: {}, store: new Store(new MemoryBackend()) });
  const records = fixture("codeforces-mixed.json").result;
  records.stopReason = "short-page";
  const result = adapter.splitByContestKind(records, range, {
    regularContestIds: new Set([2245]), gymContestIds: new Set([105001]), version: "fixture"
  });
  assert.deepEqual(result.problemset.submissions.map((item) => item.submissionId), ["383014347"]);
  assert.deepEqual(result.gym.submissions.map((item) => item.submissionId), ["990001"]);
  assert.equal(result.problemset.excludedCount, 1);
  assert.equal(result.problemset.status, "partial");
  assert.equal(result.gym.status, "partial");
  assert.notEqual(result.problemset.submissions[0].problemKey, result.gym.submissions[0].problemKey);
});

test("Codeforces Gym HTML supplement only accepts explicit authoritative Gym links", () => {
  const html = `<table><tr data-submission-id="7"><td><span class="format-time">Aug/07/2026 10:30</span></td><td><a href="/gym/105001/problem/B">B - Gym</a></td><td><span submissionVerdict="OK">Accepted</span></td></tr><tr data-submission-id="8"><td><span class="format-time">Aug/07/2026 10:31</span></td><td><a href="/contest/2245/problem/A">A - Regular</a></td><td><span submissionVerdict="OK">Accepted</span></td></tr></table>`;
  const items = parseVisibleSubmissionHtml(html, { ...range, username: "user" }, new Set([105001]));
  assert.equal(items.length, 1);
  assert.equal(items[0].problemKey, "codeforces:gym:105001:B");
});

test("browser-visible Codeforces keeps its mirror while Luogu uses its canonical record origin", () => {
  const cf = new CodeforcesAdapter({ client: { global: { location: { hostname: "m1.codeforc.es", origin: "https://m1.codeforc.es" } } } });
  assert.equal(cf.canUseVisibleGymSupplement(), true);
  assert.equal(cf.visibleSiteBase(), "https://m1.codeforc.es");
  const { LuoguAdapter } = require("../src/adapters/luogu");
  const luogu = new LuoguAdapter({ client: { global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } } } });
  assert.equal(luogu.siteBase(), "https://www.luogu.com.cn");
});

test("Codeforces URL aliases share a key and Gym dedup stays inside its namespace", () => {
  const { parseCodeforcesProblemUrl, mergeSubmissions, aggregateDaily } = require("../src/core");
  assert.equal(parseCodeforcesProblemUrl("/contest/2245/problem/G").problemKey, parseCodeforcesProblemUrl("/problemset/problem/2245/G").problemKey);
  const base = { groupId: "group", accountId: "account", judge: "codeforces", scope: "gym", username: "u", problemKey: "codeforces:gym:105001:A", submittedAt: Date.parse("2026-08-07T01:00:00Z"), verdict: "OK", accepted: true };
  const merged = mergeSubmissions([], [{ ...base, submissionId: "1" }, { ...base, submissionId: "2" }]);
  const stats = aggregateDaily(merged, [{ ...base, status: "ok", coverage: { complete: true } }], { days: 1, now: Date.parse("2026-08-07T12:00:00Z") });
  assert.equal(stats[0].submissionCount, 2);
  assert.equal(stats[0].solvedCount, 1);
});

test("Gym permission errors remain errors and duplicate supplements do not double count", async () => {
  const { mergeSubmissions } = require("../src/core");
  const { OJMonitorError } = require("../src/core");
  const client = {
    global: { location: { hostname: "codeforces.com" } },
    request: async () => { throw new OJMonitorError("permission-denied", "forbidden"); }
  };
  const adapter = new CodeforcesAdapter({ client, store: new Store(new MemoryBackend()), limiter: { waitTurn: async () => {} } });
  const failure = await adapter.fetchVisibleGymSupplement({ ...range, scope: "gym" }, { gymContestIds: new Set([105001]) });
  assert.equal(failure.status, "permission-denied");
  const base = { groupId: "group", accountId: "account", judge: "codeforces", scope: "gym", username: "u", submissionId: "7", problemKey: "codeforces:gym:105001:B", submittedAt: 1, verdict: "OK", accepted: true };
  assert.equal(mergeSubmissions([base], [{ ...base, problemName: "supplement" }]).length, 1);
});

test("AtCoder fixture explicitly converts seconds and maps only AC", () => {
  const records = fixture("atcoder-submissions.json");
  const accepted = normalizeAtCoderSubmission(records[0], range);
  const rejected = normalizeAtCoderSubmission(records[1], range);
  assert.equal(accepted.submittedAt, 1768026887000);
  assert.equal(accepted.accepted, true);
  assert.equal(rejected.accepted, false);
  assert.equal(accepted.problemKey, "atcoder:ahc059:ahc059_a");
});

test("AtCoder same-second saturated pages stop partial instead of looping or skipping", async () => {
  const page = Array.from({ length: 500 }, (_unused, index) => ({ id: index + 1, epoch_second: 100, problem_id: "a", contest_id: "abc", result: "WA" }));
  const client = { json: async () => ({ data: page, response: {} }) };
  const adapter = new AtCoderAdapter({ client, limiter: { waitTurn: async () => {} }, maxPages: 4 });
  const result = await adapter.fetchSubmissions({ ...range, from: 100000, to: 200000 });
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.reason, "same-second-saturation");
  assert.equal(result.submissions.length, 500);
});

test("VJudge fixture keeps milliseconds and does not infer Pending from statusType", () => {
  const records = fixture("vjudge-status.json").data.map((record) => normalizeVJudgeSubmission(record, range));
  assert.equal(records[0].submittedAt, 1342848775000);
  assert.equal(records[0].accepted, true);
  assert.equal(records[1].accepted, false);
  assert.equal(records[1].verdict, "Submit Failed");
  assert.equal(records[2].accepted, false);
  assert.equal(records[2].verdict, "Pending");
  assert.equal(new Set(RESULT_FILTERS).size, RESULT_FILTERS.length);
});

test("VJudge falls back to exhaustive result slices when base reaches 200", async () => {
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  let calls = 0;
  adapter.fetchSlice = async (_options, filter = "all") => {
    calls += 1;
    return filter === "all"
      ? { records: [], complete: false, totalFetched: 200 }
      : { records: [], complete: true, totalFetched: 0 };
  };
  const result = await adapter.fetchSubmissions(range);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "result-slices-not-provably-exhaustive");
  assert.equal(result.diagnostics.stopReason, "exhaustive-result-slices");
  assert.equal(calls, RESULT_FILTERS.length + 1);
});

test("VJudge follows run-id pagination even when submission times are not ordered", async () => {
  const baseRecord = (runId, time) => ({ runId, oj: "CodeForces", probNum: "1A", time, statusType: 0, processing: false, status: "Accepted" });
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  let calls = 0;
  adapter.fetchPage = async (_options, start) => {
    calls += 1;
    if (start === 0) return Array.from({ length: 100 }, (_unused, index) => baseRecord(200 - index, index % 2 ? 200 - index : 1000 - index));
    return [baseRecord(100, 100), baseRecord(99, 99)];
  };
  const complete = await adapter.fetchSubmissions({ ...range, resumeBoundary: { submissionId: "100", submittedAt: 100 } });
  assert.equal(complete.status, "ok");
  assert.equal(calls, 2);
  assert.equal(complete.coverage.complete, true);
  assert.equal(complete.submissions.length, 102);
});

test("VJudge does not use time lower bounds to stop a saturated window", async () => {
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  const page = (start) => Array.from({ length: 100 }, (_unused, index) => ({
    runId: 200 - start - index, oj: "CodeForces", probNum: "1A", time: index === 0 ? 1 : 1000000 - index,
    statusType: 0, processing: false, status: "Accepted"
  }));
  const starts = [];
  adapter.fetchPage = async (_options, start) => { starts.push(start); return page(start); };
  const result = await adapter.fetchSubmissions({ ...range, from: 500000 });
  assert.equal(result.status, "partial");
  assert.deepEqual(starts, [0, 100, ...Array.from({ length: RESULT_FILTERS.length }, (_unused, index) => [0, 100]).flat()]);
});

test("VJudge fails closed when runId order is not strictly descending", async () => {
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  adapter.fetchPage = async () => [
    { runId: 2, oj: "CodeForces", probNum: "1A", time: 2, statusType: 0, processing: false, status: "Accepted" },
    { runId: 3, oj: "CodeForces", probNum: "1A", time: 1, statusType: 0, processing: false, status: "Accepted" }
  ];
  const result = await adapter.fetchSubmissions(range);
  assert.equal(result.status, "schema-changed");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.diagnostics.stopReason, "request-error");
});

test("VJudge fails closed when pages overlap", async () => {
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  adapter.fetchPage = async (_options, start) => start === 0
    ? Array.from({ length: 100 }, (_unused, index) => ({ runId: 200 - index, oj: "CodeForces", probNum: "1A", time: index, statusType: 0, processing: false, status: "Accepted" }))
    : [{ runId: 200, oj: "CodeForces", probNum: "1A", time: 1, statusType: 0, processing: false, status: "Accepted" }];
  const result = await adapter.fetchSubmissions(range);
  assert.equal(result.status, "schema-changed");
  assert.equal(result.coverage.complete, false);
});

test("VJudge keeps valid records when an individual response row is malformed", async () => {
  const adapter = new VJudgeAdapter({ client: {}, limiter: null });
  adapter.fetchPage = async () => [
    { runId: 2, oj: "CodeForces", probNum: "1A", time: 2, statusType: 0, processing: false, status: "Accepted" },
    { runId: 1, oj: "CodeForces", probNum: "1A", time: "broken", statusType: 0, processing: false, status: "Accepted" }
  ];
  const result = await adapter.fetchSubmissions(range);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.reason, "invalid-records");
  assert.deepEqual(result.submissions.map((item) => item.submissionId), ["2"]);
});

test("Luogu content-only fixture extracts records and maps recordStatus 12 only", () => {
  const payload = fixture("luogu-content-only.json");
  const records = findRecordArray(payload);
  assert.equal(records.length, 2);
  assert.deepEqual(findRecordPage(payload), { records, totalCount: 2 });
  const normalized = records.map((record) => normalizeLuoguSubmission(record, range));
  assert.equal(normalized[0].accepted, true);
  assert.equal(normalized[1].accepted, false);
  assert.equal(normalized[0].submittedAt, 1786000000000);
  assert.equal(normalized[0].problemKey, "luogu:P1001");
  assert.equal(normalized[0].verdict, "AC");
  assert.equal(normalizeLuoguSubmission({ ...records[0], id: 10003, status: "Accepted" }, range).accepted, true);
});

test("Luogu default pagination continues beyond the former 100-page cap", async () => {
  let calls = 0;
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get("page"));
      const firstId = 10000 - (page - 1) * 2;
      return { status: 200, text: JSON.stringify({ currentData: { records: { count: 202, result: [
        { id: firstId, submitTime: firstId, status: 12, problem: { pid: `P${firstId}` } },
        { id: firstId - 1, submitTime: firstId - 1, status: 14, problem: { pid: `P${firstId - 1}` } }
      ] } } }) };
    }
  };
  const adapter = new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } });
  const result = await adapter.fetchSubmissions({ ...range, username: "1" });
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.diagnostics.stopReason, "last-page");
  assert.equal(calls, 101);
  assert.equal(result.submissions.length, 202);
});

test("Luogu repeated pagination and login shell never masquerade as complete zero data", async () => {
  const repeatedClient = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async () => ({ status: 200, text: JSON.stringify({ currentData: { records: { count: 20, result: [
      { id: 10, submitTime: 10, status: 12, problem: { pid: "P10" } }
    ] } } }) })
  };
  const repeated = await new LuoguAdapter({ client: repeatedClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1" });
  assert.equal(repeated.status, "partial");
  assert.equal(repeated.coverage.reason, "repeated-page");
  assert.equal(repeated.submissions.length, 1);

  const loginClient = {
    global: { location: { href: "https://www.luogu.com.cn/", hostname: "www.luogu.com.cn", origin: "https://www.luogu.com.cn" } },
    request: async () => ({
      status: 200,
      finalUrl: "https://www.luogu.com.cn/auth/login?redirect=%2Frecord%2Flist",
      transport: "page-realm-fetch",
      text: JSON.stringify({ instance: "auth", template: "login", data: {} })
    })
  };
  const login = await new LuoguAdapter({ client: loginClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1" });
  assert.equal(login.status, "login-required");
  assert.equal(login.coverage.complete, false);
  assert.match(login.warning, /登录/);
  assert.deepEqual(login.diagnostics.transportAttempts, [
    {
      requested: "page-fetch",
      actual: "not-attempted",
      status: "unavailable",
      reason: "缺少页面请求能力：document-root, document.createElement, document.dispatchEvent, CustomEvent"
    },
    {
      requested: "auto",
      actual: "page-realm-fetch",
      status: "login-required",
      httpStatus: 200,
      reason: "请先在洛谷登录并完成验证，再从洛谷页面重新获取",
      finalLocation: "https://www.luogu.com.cn/auth/login"
    }
  ]);
  assert.equal(diagnosticFinalLocation("https://www.luogu.com.cn/record/list?user=1&page=2#private"), "https://www.luogu.com.cn/record/list");
  assert.equal(
    diagnosticReason(new Error("failed https://www.luogu.com.cn/record/list?user=1&page=2#private")),
    "failed https://www.luogu.com.cn/record/list"
  );
});

test("Luogu incremental refresh stops on a trusted submission boundary", async () => {
  let calls = 0;
  const page = (ids) => JSON.stringify({ currentData: { records: { count: 6, result: ids.map((id) => ({
    id, submitTime: id, status: 12, problem: { pid: `P${id}` }
  })) } } });
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async (url) => {
      calls += 1;
      return { status: 200, text: Number(new URL(url).searchParams.get("page")) === 1 ? page([6, 5]) : page([4, 3]) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({
    ...range, username: "1", resumeBoundary: { submissionId: "4", submittedAt: 4000 }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "reached-known-boundary");
  assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(calls, 2);
  assert.deepEqual(result.submissions.map((item) => item.submissionId), ["3", "4", "5", "6"]);
});

test("Luogu ignores a missing trusted boundary and falls back to the time lower bound", async () => {
  let calls = 0;
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async () => {
      calls += 1;
      return { status: 200, text: JSON.stringify({ currentData: { records: { count: 2, result: [
        { id: 6, submitTime: 6, status: 12, problem: { pid: "P6" } },
        { id: 5, submitTime: 5, status: 12, problem: { pid: "P5" } }
      ] } } }) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({
    ...range, username: "1", from: 5500, resumeBoundary: { submissionId: "missing", submittedAt: 5500 }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "reached-from");
  assert.equal(calls, 1);
});

test("Luogu reads past every submission sharing the trusted boundary second", async () => {
  let calls = 0;
  const page = (records, count = 5) => JSON.stringify({ currentData: { records: { count, result: records } } });
  const record = (id, submitTime) => ({ id, submitTime, status: 12, problem: { pid: `P${id}` } });
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async () => {
      calls += 1;
      return { status: 200, text: calls === 1
        ? page([record(6, 10), record(5, 10)])
        : page([record(4, 10), record(3, 9)]) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({
    ...range, username: "1", resumeBoundary: { submissionId: "5", submittedAt: 10000 }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "reached-known-boundary");
  assert.equal(calls, 2);
  assert.deepEqual(result.submissions.map((item) => item.submissionId), ["3", "4", "5", "6"]);
});

test("Luogu falls back to the time boundary when a trusted ID timestamp changed", async () => {
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async () => ({ status: 200, text: JSON.stringify({ currentData: { records: { count: 1, result: [
      { id: 6, submitTime: 6, status: 12, problem: { pid: "P6" } }
    ] } } }) })
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({
    ...range, username: "1", from: 5500, resumeBoundary: { submissionId: "6", submittedAt: 5000 }
  });
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "last-page");
});

test("Luogu HTML login and verification responses are actionable session failures", () => {
  assert.throws(
    () => parseLuoguContentResponse({ text: '<html><form action="/auth/login"></form></html>' }),
    (error) => error.status === "login-required" && /登录页/.test(error.message)
  );
  assert.throws(
    () => parseLuoguContentResponse({ text: "<!doctype html><script src='/cdn-cgi/challenge-platform/x'></script>" }),
    (error) => error.status === "verification-required"
  );
});

test("Luogu record HTML restores the embedded lentille context instead of claiming logout", () => {
  const payload = fixture("luogu-content-only.json");
  const html = `<!doctype html><html><head></head><body><script type="application/json" id="lentille-context">${JSON.stringify(payload)}</script><div id="app"></div></body></html>`;
  assert.deepEqual(parseLentilleContextHtml(html), payload);
  assert.deepEqual(parseLuoguContentResponse({
    status: 200,
    finalUrl: "https://www.luogu.com.cn/record/list?user=1&page=1",
    text: html
  }), payload);
  assert.throws(
    () => parseLuoguContentResponse({
      status: 200,
      finalUrl: "https://www.luogu.com.cn/record/list?user=1&page=1",
      text: "<!doctype html><html><body><div id=\"app\"></div></body></html>"
    }),
    (error) => error.status === "schema-changed" && /不等同于未登录/.test(error.message)
  );
  assert.throws(
    () => parseLuoguContentResponse({
      status: 200,
      finalUrl: "https://www.luogu.com.cn/auth/login?redirect=%2Frecord%2Flist",
      text: "<!doctype html><html><body><div id=\"app\"></div></body></html>"
    }),
    (error) => error.status === "login-required"
  );
});

test("Luogu requests the legacy DataResponse contract and keeps Lentille HTML only as fallback", async () => {
  let requestUrl;
  let requestHeaders;
  const payload = { currentData: { records: { count: 1, result: [
    { id: 1, submitTime: 100, status: 12, problem: { pid: "P1" } }
  ] } } };
  const client = {
    global: { location: { href: "https://www.luogu.com.cn/", hostname: "www.luogu.com.cn", origin: "https://www.luogu.com.cn" } },
    request: async (url, options) => {
      requestUrl = url;
      requestHeaders = options.headers;
      const request = new URL(url);
      const usesLegacyContract = request.searchParams.get("_contentOnly") === "1" &&
        options.headers["x-luogu-type"] === "content-only" &&
        options.headers["x-lentille-request"] === undefined;
      return {
        status: 200,
        finalUrl: "https://www.luogu.com.cn/record/list",
        transport: "page-realm-fetch",
        text: usesLegacyContract
          ? JSON.stringify(payload)
          : "<!doctype html><html><body><div id=\"app\"></div></body></html>"
      };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1" });
  assert.equal(new URL(requestUrl).searchParams.get("_contentOnly"), "1");
  assert.equal(requestHeaders["x-luogu-type"], "content-only");
  assert.equal(requestHeaders["x-lentille-request"], undefined);
  assert.equal(requestHeaders["x-requested-with"], "XMLHttpRequest");
  assert.equal(result.status, "ok");
  assert.equal(result.submissions.length, 1);
  assert.equal(result.diagnostics.transport, "page-realm-fetch");
  assert.equal(result.diagnostics.source, "legacy-data-response");
});

test("Luogu crosses from a different OJ page to an open Luogu session tab", async () => {
  const calls = [];
  const client = {
    global: {
      GM_xmlhttpRequest() {},
      location: { href: "https://atcoder.jp/", hostname: "atcoder.jp", origin: "https://atcoder.jp" }
    },
    siteBridge: {},
    request: async (_url, options) => {
      calls.push(options.transport || "auto");
      if (options.transport === "gm-xhr") return { status: 200, transport: "gm-xhr", text: JSON.stringify({ instance: "auth", template: "login" }) };
      return { status: 200, transport: "site-tab:firefox-content-fetch", text: JSON.stringify({ currentData: { records: { count: 1, result: [
        { id: 1, submitTime: 100, status: 12, problem: { pid: "P1" } }
      ] } } }) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1" });
  assert.deepEqual(calls, ["gm-xhr", "site-bridge"]);
  assert.equal(result.status, "ok");
  assert.equal(result.submissions[0].accepted, true);
  assert.equal(result.diagnostics.transport, "site-tab:firefox-content-fetch");
  assert.deepEqual(result.diagnostics.attemptedTransports, ["gm-xhr", "site-bridge"]);
  assert.deepEqual(result.diagnostics.transportAttempts.map(({ requested, actual, status }) => ({ requested, actual, status })), [
    { requested: "page-fetch", actual: "not-attempted", status: "unavailable" },
    { requested: "gm-xhr", actual: "gm-xhr", status: "login-required" },
    { requested: "site-bridge", actual: "site-tab:firefox-content-fetch", status: "ok" }
  ]);
});

test("Luogu count contradiction is partial instead of a false complete empty page", async () => {
  let calls = 0;
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get("page"));
      if (page > 12) return { status: 200, text: JSON.stringify({ currentData: { records: { count: 100000, result: [] } } }) };
      const start = 100000 - (page - 1) * 20;
      const result = Array.from({ length: 20 }, (_unused, index) => ({
        id: start - index, submitTime: start - index, status: 12, problem: { pid: `P${start - index}` }
      }));
      return { status: 200, text: JSON.stringify({ currentData: { records: { count: 100000, result } } }) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1" });
  assert.equal(calls, 13);
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, "count-mismatch");
  assert.match(result.warning, /100000.*240/);
});

test("Luogu default pagination is bounded by the requested date rather than a page count", async () => {
  let calls = 0;
  const day = 86400000;
  const to = Date.parse("2026-08-07T12:00:00Z");
  const from = to - 89 * day;
  const client = {
    global: { location: { hostname: "luogu.com.cn", origin: "https://luogu.com.cn" } },
    request: async (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get("page"));
      return { status: 200, text: JSON.stringify({ currentData: { records: { result: [
        { id: 200000 - page, submitTime: (to - (page - 1) * day) / 1000, status: 12, problem: { pid: `P${page}` } }
      ] } } }) };
    }
  };
  const result = await new LuoguAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "1", from, to });
  assert.equal(DEFAULT_MAX_PAGES, null);
  assert.equal(calls, 91);
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "reached-from");
  assert.equal(result.coverage.reason, undefined);
  assert.equal(result.submissions.length, 90);
});

test("NowCoder fixture maps semantic columns, HTML entities, UTC+8 assumption and exact acceptance", () => {
  const html = textFixture("nowcoder-practice-coding.html").replace("<body>", "<body><table><tr><th>无关表头</th></tr></table>");
  const parsed = parseNowcoderPracticeHtml(html, { ...nowcoderRange, page: 1 });
  assert.equal(parsed.hasNext, true);
  assert.equal(parsed.totalPages, 2);
  assert.equal(parsed.displayName, "Alice & Bob");
  assert.deepEqual(parsed.submissions.map((item) => item.submissionId), ["103", "102", "101"]);
  assert.deepEqual(parsed.submissions.map((item) => item.accepted), [true, false, false]);
  assert.equal(parsed.submissions[0].problemKey, "nowcoder:200");
  assert.equal(parsed.submissions[0].problemName, "A & B");
  assert.equal(parsed.submissions[1].problemName, "Wrong <answer>");
  assert.equal(parsed.submissions[0].problemUrl, "https://ac.nowcoder.com/acm/problem/200");
  assert.equal(parsed.submissions[0].submittedAt, Date.parse("2026-08-07T11:20:30+08:00"));
  assert.equal(parseNowcoderTime("2026-08-07 00:00:00"), Date.parse("2026-08-07T00:00:00+08:00"));
  assert.deepEqual(["答案正确", " 答案正确 ", "答案错误", "运行超时", "100"].map(isAcceptedNowcoderVerdict), [true, true, false, false, false]);
});

test("NowCoder Rating parser resolves exact case-folded usernames without dropping underscores", () => {
  const html = textFixture("nowcoder-rating-search.html");
  assert.deepEqual(parseNowcoderRatingHtml(html, "Example_user"), { uid: "900000000000000001", canonicalName: "Example_user" });
  assert.deepEqual(parseNowcoderRatingHtml(html, "example_USER"), { uid: "900000000000000001", canonicalName: "Example_user" });
  assert.throws(() => parseNowcoderRatingHtml(html, "Exampleuser"), (error) => error.status === "not-found");
  assert.throws(() => parseNowcoderRatingHtml(html, "Example"), (error) => error.status === "not-found");

  const duplicateSameUid = html.replace("</tbody>", '<tr><td>1</td><td><a href="/acm/contest/profile/900000000000000001"><span>Example_user</span></a></td><td></td><td></td><td>1</td></tr></tbody>');
  assert.equal(parseNowcoderRatingHtml(duplicateSameUid, "Example_user").uid, "900000000000000001");
  const ambiguous = html.replace("</tbody>", '<tr><td>2</td><td><a href="/acm/contest/profile/900000000000000002"><span>example_USER</span></a></td><td></td><td></td><td>2</td></tr></tbody>');
  assert.throws(() => parseNowcoderRatingHtml(ambiguous, "Example_user"), (error) => error.status === "not-found" && /多个 UID/.test(error.message));
});

test("NowCoder username resolution is shared, cached and preserves the canonical competition name", async () => {
  const rating = textFixture("nowcoder-rating-search.html");
  const profile = examplePracticeHtml();
  const client = nowcoderIdentifierClient(rating, { 1: profile });
  const adapter = new NowcoderAdapter({ client, limiter: { waitTurn: async () => {} } });

  assert.deepEqual(await adapter.resolveIdentifier("Example_user"), { uid: "900000000000000001", canonicalName: "Example_user" });
  assert.deepEqual(await adapter.resolveIdentifier("example_USER"), { uid: "900000000000000001", canonicalName: "Example_user" });
  const validation = await adapter.validateUser("example_USER");
  assert.deepEqual(validation, { exists: true, canonicalUsername: "900000000000000001", displayName: "Example_user", status: "ok" });
  const ratingCalls = client.calls.filter((url) => new URL(url).pathname === "/acm/contest/rating-index");
  assert.equal(ratingCalls.length, 1);
  assert.equal(new URL(ratingCalls[0]).searchParams.get("searchUserName"), "Example_user");
});

test("NowCoder username resolution fails closed on redirects, missing schema and display mismatch", async () => {
  const rating = textFixture("nowcoder-rating-search.html");
  const redirected = new NowcoderAdapter({
    client: { request: async (url) => ({ status: 200, finalUrl: "https://ac.nowcoder.com/", text: rating }) },
    limiter: { waitTurn: async () => {} }
  });
  assert.equal((await redirected.validateUser("Example_user")).status, "schema-changed");

  for (const finalUrl of [
    "https://ac.nowcoder.com/acm/contest/rating-index?page=1&pageSize=50",
    "https://ac.nowcoder.com/acm/contest/rating-index?page=1&pageSize=50&searchUserName=Other_user"
  ]) {
    const lostFilter = new NowcoderAdapter({
      client: { request: async () => ({ status: 200, finalUrl, text: rating }) },
      limiter: { waitTurn: async () => {} }
    });
    assert.equal((await lostFilter.validateUser("Example_user")).status, "schema-changed");
  }

  const missingSchema = new NowcoderAdapter({
    client: { request: async (url) => ({ status: 200, finalUrl: url, text: "<html>页面找不到了</html>" }) },
    limiter: { waitTurn: async () => {} }
  });
  assert.equal((await missingSchema.validateUser("Example_user")).status, "schema-changed");

  const wrongDisplayClient = nowcoderIdentifierClient(rating, { 1: examplePracticeHtml().replaceAll("Example_user", "Other_user") });
  const wrongDisplay = await new NowcoderAdapter({ client: wrongDisplayClient, limiter: { waitTurn: async () => {} } }).validateUser("Example_user");
  assert.equal(wrongDisplay.status, "schema-changed");
});

test("NowCoder numeric UIDs bypass Rating lookup", async () => {
  const client = nowcoderIdentifierClient(textFixture("nowcoder-rating-search.html"), { 1: examplePracticeHtml() });
  const validation = await new NowcoderAdapter({ client, limiter: { waitTurn: async () => {} } }).validateUser("900000000000000001");
  assert.equal(validation.status, "ok");
  assert.equal(validation.canonicalUsername, "900000000000000001");
  assert.equal(client.calls.length, 1);
  assert.equal(new URL(client.calls[0]).pathname, "/acm/contest/profile/900000000000000001/practice-coding");
});

test("NowCoder proves exact zero from identity, semantic headers and submission total without relying on copy", () => {
  const parsed = parseNowcoderPracticeHtml(textFixture("nowcoder-empty.html"), { ...nowcoderRange, username: "665290627", page: 1 });
  assert.equal(parsed.explicitEmpty, true);
  assert.deepEqual(parsed.submissions, []);

  const unproved = textFixture("nowcoder-empty.html").replace('<div class="state-num">0</div><span>次提交</span>', '<div class="state-num">1</div><span>次提交</span>');
  assert.throws(
    () => parseNowcoderPracticeHtml(unproved, { ...nowcoderRange, username: "665290627", page: 1 }),
    (error) => error.status === "schema-changed"
  );
});

test("NowCoder rejects invalid UIDs without a request and detects redirects or identity mismatch", async () => {
  let called = false;
  const invalid = await new NowcoderAdapter({ client: { request: async () => { called = true; } } }).fetchSubmissions({ ...nowcoderRange, username: "0" });
  assert.equal(invalid.status, "not-found");
  const tooLong = await new NowcoderAdapter({ client: { request: async () => { called = true; } } }).fetchSubmissions({ ...nowcoderRange, username: "1234567890123456789" });
  assert.equal(tooLong.status, "not-found");
  for (const username of ["Example_\u0001user", "x".repeat(65)]) {
    const invalidUsername = await new NowcoderAdapter({ client: { request: async () => { called = true; } } }).fetchSubmissions({ ...nowcoderRange, username });
    assert.equal(invalidUsername.status, "not-found");
  }
  assert.equal(called, false);

  const redirected = await new NowcoderAdapter({ client: { request: async () => ({ status: 200, finalUrl: "https://ac.nowcoder.com/", text: "<html></html>" }) } }).validateUser("123456789");
  assert.equal(redirected.exists, false);
  assert.equal(redirected.status, "not-found");

  const wrongIdentity = textFixture("nowcoder-practice-coding.html").replace('window.curUser.id = "123456789"', 'window.curUser.id = "987654321"');
  const mismatch = await new NowcoderAdapter({ client: { request: async (url) => ({ status: 200, finalUrl: url, text: wrongIdentity }) } }).validateUser("123456789");
  assert.equal(mismatch.exists, null);
  assert.equal(mismatch.status, "schema-changed");
});

test("NowCoder pagination stops complete at the requested date boundary", async () => {
  const fixtureHtml = textFixture("nowcoder-practice-coding.html");
  const client = nowcoderClient({ 1: fixtureHtml });
  const from = Date.parse("2026-08-07T00:00:00+08:00");
  const result = await new NowcoderAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...nowcoderRange, from });
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.diagnostics.stopReason, "reached-from");
  assert.deepEqual(result.submissions.map((item) => item.submissionId), ["102", "103"]);
  assert.equal(client.calls.length, 1);
  const query = new URL(client.calls[0]).searchParams;
  assert.equal(query.get("pageSize"), "50");
  assert.equal(query.get("statusTypeFilter"), "-1");
  assert.equal(query.get("languageCategoryFilter"), "-1");
  assert.equal(query.get("orderType"), "DESC");
});

test("NowCoder pagination reports repeated pages and cross-page overlap as partial", async () => {
  const first = textFixture("nowcoder-practice-coding.html");
  const repeatedClient = nowcoderClient({ 1: first, 2: first });
  const repeated = await new NowcoderAdapter({ client: repeatedClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions(nowcoderRange);
  assert.equal(repeated.status, "partial");
  assert.equal(repeated.coverage.reason, "repeated-page");

  const overlappingSecond = first
    .replaceAll("submissionId=103", "submissionId=100")
    .replaceAll(">103<", ">100<")
    .replaceAll("submissionId=102", "submissionId=99")
    .replaceAll(">102<", ">99<")
    .replaceAll("2026-08-07 11:20:30", "2026-08-05 11:20:30")
    .replaceAll("2026-08-07 10:20:30", "2026-08-05 10:20:30")
    .replaceAll("2026-08-06 09:20:30", "2026-08-05 09:20:30")
    .replace(/<div class="pagination">[\s\S]*?<\/div>/, "");
  const overlapClient = nowcoderClient({ 1: first, 2: overlappingSecond });
  const overlap = await new NowcoderAdapter({ client: overlapClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions(nowcoderRange);
  assert.equal(overlap.status, "partial");
  assert.equal(overlap.coverage.reason, "overlapping-page");
});

test("NowCoder rejects time disorder and marks an injected page cap partial", async () => {
  const first = textFixture("nowcoder-practice-coding.html");
  const disordered = first.replace("2026-08-07 10:20:30", "2026-08-08 10:20:30");
  const disorderClient = nowcoderClient({ 1: disordered });
  const disorder = await new NowcoderAdapter({ client: disorderClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions(nowcoderRange);
  assert.equal(disorder.status, "schema-changed");
  assert.equal(disorder.coverage.complete, false);

  const crossPageJump = first
    .replaceAll("submissionId=103", "submissionId=203").replaceAll(">103<", ">203<")
    .replaceAll("submissionId=102", "submissionId=202").replaceAll(">102<", ">202<")
    .replaceAll("submissionId=101", "submissionId=201").replaceAll(">101<", ">201<")
    .replaceAll("2026-08-07", "2026-08-08")
    .replaceAll("2026-08-06", "2026-08-07");
  const crossPageClient = nowcoderClient({ 1: first, 2: crossPageJump });
  const crossPageDisorder = await new NowcoderAdapter({ client: crossPageClient, limiter: { waitTurn: async () => {} } }).fetchSubmissions(nowcoderRange);
  assert.equal(crossPageDisorder.status, "schema-changed");
  assert.match(crossPageDisorder.warning, /跨页/);

  const cappedClient = nowcoderClient({ 1: first });
  const capped = await new NowcoderAdapter({ client: cappedClient, limiter: { waitTurn: async () => {} }, maxPages: 1 }).fetchSubmissions(nowcoderRange);
  assert.equal(capped.status, "partial");
  assert.equal(capped.coverage.reason, "page-limit");
});

test("NowCoder confirms completion only after the declared last page", async () => {
  const first = textFixture("nowcoder-practice-coding.html");
  const last = first
    .replaceAll("submissionId=103", "submissionId=203").replaceAll(">103<", ">203<")
    .replaceAll("submissionId=102", "submissionId=202").replaceAll(">102<", ">202<")
    .replaceAll("submissionId=101", "submissionId=201").replaceAll(">101<", ">201<")
    .replaceAll("2026-08-07", "2026-08-05")
    .replaceAll("2026-08-06", "2026-08-04");
  const client = nowcoderClient({ 1: first, 2: last });
  const result = await new NowcoderAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions(nowcoderRange);
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.diagnostics.stopReason, "last-page");
  assert.equal(client.calls.length, 2);
});

test("NowCoder resolved usernames keep full pagination and canonical record names", async () => {
  const first = examplePracticeHtml();
  const last = examplePracticeHtml()
    .replaceAll("submissionId=103", "submissionId=203").replaceAll(">103<", ">203<")
    .replaceAll("submissionId=102", "submissionId=202").replaceAll(">102<", ">202<")
    .replaceAll("submissionId=101", "submissionId=201").replaceAll(">101<", ">201<")
    .replaceAll("2026-08-07", "2026-08-05")
    .replaceAll("2026-08-06", "2026-08-04");
  const client = nowcoderIdentifierClient(textFixture("nowcoder-rating-search.html"), { 1: first, 2: last });
  const result = await new NowcoderAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...nowcoderRange, username: "example_USER" });
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "last-page");
  assert.equal(result.diagnostics.resolvedUid, "900000000000000001");
  assert.equal(client.calls.length, 3);
  assert.ok(result.submissions.every((submission) => submission.username === "Example_user"));
  assert.ok(client.calls.slice(1).every((url) => new URL(url).pathname === "/acm/contest/profile/900000000000000001/practice-coding"));
});

test("QOJ UOJ-derived fixture maps semantic columns, UTC+8 time and only full acceptance", () => {
  const parsed = parseQojSubmissionsHtml(textFixture("qoj-submissions.html"), { ...range, username: "alice", page: 1, base: "https://qoj.ac" });
  assert.equal(parsed.hasNext, true);
  assert.deepEqual(parsed.submissions.map((item) => item.submissionId), ["321", "320", "319", "318"]);
  assert.deepEqual(parsed.submissions.map((item) => item.accepted), [true, true, false, false]);
  assert.equal(parsed.submissions[0].problemKey, "qoj:42");
  assert.equal(parsed.submissions[0].problemUrl, "https://qoj.ac/contest/17/problem/42");
  assert.equal(parsed.submissions[0].submittedAt, Date.parse("2026-08-07T11:20:30+08:00"));
  assert.equal(parseQojTime("2026-08-07 00:00:00"), Date.parse("2026-08-07T00:00:00+08:00"));
  assert.deepEqual(["AC", "AC ✓", "Accepted!", "Accepted ✔", "100", "100.0", "99.5", "WA"].map(isAcceptedQojVerdict), [true, true, true, true, true, true, false, false]);
});

test("QOJ parser follows reordered Chinese semantic headers instead of fixed columns", () => {
  const html = `<table><thead><tr><th>提交时间</th><th>结果</th><th>提交者</th><th>ID</th><th>题目</th></tr></thead><tbody><tr><td>2026-08-07 12:00:00</td><td>100</td><td>user</td><td><a href="/submission/5">#5</a></td><td><a href="/problem/3">#3. 三</a></td></tr></tbody></table>`;
  const parsed = parseQojSubmissionsHtml(html, { ...range, page: 1, base: "https://qoj.ac" });
  assert.equal(parsed.submissions[0].submissionId, "5");
  assert.equal(parsed.submissions[0].problemKey, "qoj:3");
  assert.equal(parsed.submissions[0].accepted, true);
});

test("QOJ accepts official hyphenated team usernames and rejects ignored filters", async () => {
  const adapter = new QojAdapter({ client: { global: {}, request: async () => ({ status: 200, text: "" }) } });
  assert.doesNotThrow(() => adapter.assertUsername("ucup-team001"));
  const html = `<table><thead><tr><th>ID</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Submit time</th></tr></thead><tbody><tr><td><a href="/submission/5">#5</a></td><td><a href="/problem/3">#3</a></td><td>someone-else</td><td>100</td><td>2026-08-07 12:00:00</td></tr></tbody></table>`;
  assert.throws(
    () => parseQojSubmissionsHtml(html, { ...range, username: "ucup-team001", page: 1 }),
    (error) => error.status === "schema-changed" && /筛选未生效/.test(error.message)
  );
});

test("QOJ extracts the semantic submitter instead of adjacent hash markers", () => {
  const row = (submitter) => `<table><thead><tr><th>ID</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Submit time</th></tr></thead><tbody><tr><td><a href="/submission/5">#5</a></td><td><a href="/problem/3">#3</a></td><td>${submitter}</td><td>100</td><td>2026-08-07 12:00:00</td></tr></tbody></table>`;
  const structured = row(`<a href="/user/profile/Zenith"><span class="uoj-username">Zenith</span></a> <a href="/submissions?submitter=Zenith">#</a>`);
  const parsed = parseQojSubmissionsHtml(structured, { ...range, username: "Zenith", page: 1, base: "https://qoj.ac" });
  assert.equal(parsed.submissions.length, 1);
  assert.equal(parsed.submissions[0].username, "Zenith");

  const plainFallback = parseQojSubmissionsHtml(row("Zenith #"), { ...range, username: "Zenith", page: 1, base: "https://qoj.ac" });
  assert.equal(plainFallback.submissions.length, 1);
  assert.throws(
    () => parseQojSubmissionsHtml(row(`<span class="uoj-username">Zenith2</span> #`), { ...range, username: "Zenith", page: 1 }),
    (error) => error.status === "schema-changed" && /实际为 Zenith2/.test(error.message)
  );
});

test("QOJ proves a filtered empty page without hiding arbitrary schema changes", async () => {
  const emptyHtml = `<html><head><title>Submissions - QOJ.ac</title></head><body><form action="/submissions" method="get"><input name="submitter" value="NoRecord"><button>Search</button></form><p class="text-muted">No submissions found.</p></body></html>`;
  const parsed = parseQojSubmissionsHtml(emptyHtml, { ...range, username: "NoRecord", page: 1, base: "https://qoj.ac" });
  assert.deepEqual(parsed, { submissions: [], hasNext: false, signature: "" });

  const client = {
    global: { location: { hostname: "qoj.ac", origin: "https://qoj.ac" } },
    request: async (url) => url.includes("/user/profile/")
      ? { status: 200, text: "<h1>NoRecord</h1>" }
      : { status: 200, text: emptyHtml }
  };
  const result = await new QojAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "NoRecord" });
  assert.equal(result.status, "ok");
  assert.equal(result.submissions.length, 0);
  assert.equal(result.diagnostics.stopReason, "empty-page");
  assert.equal(result.diagnostics.pagesFetched, 1);

  assert.throws(
    () => parseQojSubmissionsHtml("<html><h1>Submissions temporarily unavailable</h1></html>", { ...range, username: "NoRecord", page: 1 }),
    (error) => error.status === "schema-changed" && /缺少表头/.test(error.message)
  );
  const wrongFilter = emptyHtml.replace('value="NoRecord"', 'value="SomeoneElse"');
  assert.throws(
    () => parseQojSubmissionsHtml(wrongFilter, { ...range, username: "NoRecord", page: 1 }),
    (error) => error.status === "schema-changed" && /缺少表头/.test(error.message)
  );
});

test("QOJ uses same-origin session and paginates until the visible last page", async () => {
  const fixtureHtml = textFixture("qoj-submissions.html");
  const urls = [];
  const client = {
    global: { location: { hostname: "qoj.ac", origin: "https://qoj.ac" } },
    request: async (url) => {
      urls.push(url);
      if (url.includes("/user/profile/")) return { status: 200, text: "<html><h1>alice</h1></html>" };
      const page = Number(new URL(url).searchParams.get("page"));
      return { status: 200, text: page === 1 ? fixtureHtml : fixtureHtml
        .replace(/<ul class="pagination">[\s\S]*?<\/ul>/, "")
        .replaceAll("321", "221").replaceAll("320", "220").replaceAll("319", "219").replaceAll("318", "218")
        .replaceAll("2026-08-07", "2026-08-06") };
    }
  };
  const adapter = new QojAdapter({ client, limiter: { waitTurn: async () => {} } });
  const result = await adapter.fetchSubmissions({ ...range, username: "alice" });
  assert.equal(adapter.siteBase(), "https://qoj.ac");
  assert.equal(adapter.maxPages, null);
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.complete, true);
  assert.equal(result.diagnostics.stopReason, "last-page");
  assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(urls.length, 3);
});

test("QOJ crosses from another OJ page to an open verified QOJ tab", async () => {
  const fixtureHtml = textFixture("qoj-submissions.html").replace(/<ul class="pagination">[\s\S]*?<\/ul>/, "");
  const calls = [];
  const client = {
    global: {
      location: { href: "https://atcoder.jp/", hostname: "atcoder.jp", origin: "https://atcoder.jp" },
      GM_xmlhttpRequest() {}
    },
    siteBridge: {},
    request: async (url, options) => {
      calls.push(options.transport || "auto");
      if (options.transport === "gm-xhr") {
        const error = new Error("Cloudflare challenge");
        error.status = "verification-required";
        throw error;
      }
      return {
        status: 200,
        transport: "site-tab:firefox-content-fetch",
        text: url.includes("/user/profile/") ? "<h1>alice</h1>" : fixtureHtml
      };
    }
  };
  const result = await new QojAdapter({ client, limiter: { waitTurn: async () => {} } }).fetchSubmissions({ ...range, username: "alice" });
  assert.equal(result.status, "ok");
  assert.equal(result.submissions.length, 4);
  assert.deepEqual(calls, ["gm-xhr", "site-bridge", "gm-xhr", "site-bridge"]);
  assert.equal(result.diagnostics.transport, "site-tab:firefox-content-fetch");
  assert.deepEqual(result.diagnostics.attemptedTransports, ["gm-xhr", "site-bridge"]);
});

test("QOJ rejects invalid usernames before an ignored filter could expose global submissions", async () => {
  let called = false;
  const adapter = new QojAdapter({ client: { global: {}, request: async () => { called = true; } } });
  const result = await adapter.fetchSubmissions({ ...range, username: "bad-name!" });
  assert.equal(result.status, "not-found");
  assert.equal(called, false);
});

test("QOJ pagination safety cap is explicit partial, never complete", async () => {
  const fixtureHtml = textFixture("qoj-submissions.html");
  const client = {
    global: { location: { hostname: "qoj.ac", origin: "https://qoj.ac" } },
    request: async (url) => url.includes("/user/profile/")
      ? { status: 200, text: "<h1>alice</h1>" }
      : { status: 200, text: fixtureHtml }
  };
  const result = await new QojAdapter({ client, limiter: { waitTurn: async () => {} }, maxPages: 1 }).fetchSubmissions({ ...range, username: "alice" });
  assert.equal(result.status, "partial");
  assert.equal(result.coverage.reason, "page-limit");
});
