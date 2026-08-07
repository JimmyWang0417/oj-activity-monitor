"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AtCoderAdapter, normalizeAtCoderSubmission } = require("../src/adapters/atcoder");
const { CodeforcesAdapter, parseVisibleSubmissionHtml } = require("../src/adapters/codeforces");
const { DEFAULT_MAX_PAGES, diagnosticFinalLocation, diagnosticReason, findRecordArray, findRecordPage, LuoguAdapter, normalizeLuoguSubmission, parseLentilleContextHtml, parseLuoguContentResponse } = require("../src/adapters/luogu");
const { QojAdapter, isAcceptedQojVerdict, parseQojSubmissionsHtml, parseQojTime } = require("../src/adapters/qoj");
const { RESULT_FILTERS, VJudgeAdapter, normalizeVJudgeSubmission } = require("../src/adapters/vjudge");
const { MemoryBackend, Store } = require("../src/storage");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const textFixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const range = {
  groupId: "group", accountId: "account", username: "user", scope: "default",
  from: 0, to: Date.parse("2030-01-01T00:00:00Z")
};

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
  assert.equal(result.status, "ok");
  assert.equal(result.diagnostics.stopReason, "exhaustive-result-slices");
  assert.equal(calls, RESULT_FILTERS.length + 1);
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
