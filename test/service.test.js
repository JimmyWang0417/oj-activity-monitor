"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MonitorService, windowBounds } = require("../src/service");
const { MemoryBackend, Store } = require("../src/storage");

const now = Date.parse("2026-08-07T12:00:00+08:00");
const config = {
  groups: [{ id: "g", name: "Alice", accounts: [
    { id: "cf", judge: "codeforces", username: "alice", enabled: true, scopes: { problemset: true, gym: true } },
    { id: "at", judge: "atcoder", username: "alice", enabled: true }
  ] }],
  settings: { days: 7, timeZone: "Asia/Shanghai", metric: "solved", autoRefreshMinutes: 15, theme: "system" }
};

function result(base, judge, scope, submissions = [], complete = true) {
  return { ...base, judge, scope, status: complete ? "ok" : "partial", updatedAt: now, submissions, excludedCount: 0, coverage: { from: base.from, to: base.to, complete } };
}

test("window bounds start at configured timezone natural day", () => {
  const bounds = windowBounds(config.settings, now);
  assert.equal(bounds.dateKeys[0], "2026-08-01");
  assert.equal(bounds.from, Date.parse("2026-08-01T00:00:00+08:00"));
  assert.equal(bounds.to, now);
});

test("refresh fetches Codeforces once then persists separate Problemset/Gym results", async () => {
  const store = new Store(new MemoryBackend());
  let cfCalls = 0;
  const adapters = {
    codeforces: { fetchBoth: async (base) => {
      cfCalls += 1;
      const common = { groupId: base.groupId, accountId: base.accountId, username: base.username, from: base.from, to: base.to };
      return {
        problemset: result(common, "codeforces", "problemset", [{ ...common, judge: "codeforces", scope: "problemset", submissionId: "1", problemKey: "codeforces:problemset:1:A", submittedAt: now, verdict: "OK", accepted: true }]),
        gym: result(common, "codeforces", "gym", [{ ...common, judge: "codeforces", scope: "gym", submissionId: "1", problemKey: "codeforces:gym:1:A", submittedAt: now, verdict: "OK", accepted: true }])
      };
    } },
    atcoder: { fetchSubmissions: async (base) => result(base, "atcoder", "default") }
  };
  const service = new MonitorService({ store, adapters, clock: () => now });
  const dashboard = await service.refresh(config);
  assert.equal(cfCalls, 1);
  assert.equal(dashboard.results.length, 3);
  assert.equal(dashboard.submissions.length, 2);
  assert.equal(dashboard.stats.filter((item) => item.date === "2026-08-07").reduce((sum, item) => sum + item.solvedCount, 0), 2);
  assert.equal((await service.loadDashboard(config)).stats.length, 21);
});

test("one adapter crash becomes a source error and does not block other judges", async () => {
  const store = new Store(new MemoryBackend());
  const adapters = {
    codeforces: { fetchBoth: async () => { throw new Error("boom"); } },
    atcoder: { fetchSubmissions: async (base) => result(base, "atcoder", "default") }
  };
  const service = new MonitorService({ store, adapters, clock: () => now });
  const dashboard = await service.refresh(config);
  assert.equal(dashboard.results.filter((item) => item.status === "network-error").length, 2);
  assert.equal(dashboard.results.some((item) => item.judge === "atcoder" && item.status === "ok"), true);
});

test("a complete cached window makes the next refresh overlap only one day", async () => {
  const store = new Store(new MemoryBackend());
  const seenFrom = [];
  const adapters = {
    codeforces: { fetchBoth: async (base) => {
      seenFrom.push(base.from);
      return {
        problemset: result(base, "codeforces", "problemset"),
        gym: result(base, "codeforces", "gym")
      };
    } },
    atcoder: { fetchSubmissions: async (base) => { seenFrom.push(base.from); return result(base, "atcoder", "default"); } }
  };
  const service = new MonitorService({ store, adapters, clock: () => now });
  await service.refresh(config);
  seenFrom.length = 0;
  await service.refresh(config);
  assert.deepEqual(new Set(seenFrom), new Set([now - 86400000]));
  const state = await store.loadSourceState("g:cf:codeforces:problemset");
  assert.equal(state.coverage.from, windowBounds(config.settings, now).from);
});
