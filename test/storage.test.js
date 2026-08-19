"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryBackend, Store, decodeEnvelope, encodeEnvelope } = require("../src/storage");

function item(id, month = "08") {
  return {
    groupId: "g", accountId: "a", judge: "atcoder", scope: "default", username: "u",
    submissionId: id, problemKey: `atcoder:abc:${id}`,
    submittedAt: Date.parse(`2026-${month}-01T00:00:00Z`), verdict: "AC", accepted: true
  };
}

test("storage envelope detects corruption", () => {
  const encoded = encodeEnvelope({ ok: true });
  assert.deepEqual(decodeEnvelope(encoded), { ok: true });
  assert.throws(() => decodeEnvelope(encoded.replace("true", "false")), /checksum/i);
});

test("submission chunks merge idempotently and can be removed per account", async () => {
  const store = new Store(new MemoryBackend());
  await store.mergeSubmissions([item("1"), item("2", "07")]);
  await store.mergeSubmissions([item("1"), item("3")]);
  assert.deepEqual((await store.loadSubmissions()).map((entry) => entry.submissionId), ["2", "1", "3"]);
  await store.saveDailyStats([{ groupId: "g", accountId: "a", judge: "atcoder", scope: "default", date: "2026-08-01", submissionCount: 1, solvedCount: 1 }]);
  await store.saveSourceState("g:a:atcoder:default", { status: "ok" });
  await store.removeAccount("a");
  assert.deepEqual(await store.loadSubmissions(), []);
  assert.deepEqual(await store.loadDailyStats(), []);
  assert.equal(await store.loadSourceState("g:a:atcoder:default"), null);
});

test("submission cache keeps older fixed-window records and upserts rejudged IDs", async () => {
  const store = new Store(new MemoryBackend());
  const older = item("old", "01");
  const recent = item("recent", "02");
  await store.mergeSubmissions([older, recent]);
  await store.mergeSubmissions([{ ...recent, verdict: "WA", accepted: false }]);
  const cached = await store.loadSubmissions();
  assert.deepEqual(cached.map((item) => item.submissionId), ["old", "recent"]);
  assert.equal(cached.find((item) => item.submissionId === "recent").verdict, "WA");
  assert.equal(cached.find((item) => item.submissionId === "recent").accepted, false);
});

test("partial source state preserves the last complete trusted cache", async () => {
  const store = new Store(new MemoryBackend());
  const complete = {
    status: "ok",
    coverage: { from: 1, to: 10, complete: true },
    diagnostics: { resumeBoundary: { submissionId: "10", submittedAt: 10 }, fullScanAt: 10 }
  };
  await store.saveSourceState("g:a:vjudge:default", complete);
  await store.saveSourceState("g:a:vjudge:default", {
    status: "partial",
    coverage: { from: 5, to: 20, complete: false, reason: "slice-truncated" },
    diagnostics: { stopReason: "slice-truncated" }
  });
  const state = await store.loadSourceState("g:a:vjudge:default");
  assert.equal(state.status, "partial");
  assert.deepEqual(state.trusted, complete);
});

test("corrupt source state is replaced by the next valid state", async () => {
  const backend = new MemoryBackend();
  const store = new Store(backend);
  await backend.set("oj-monitor:v1:source:g:a:vjudge:default", "corrupt");
  await store.saveSourceState("g:a:vjudge:default", { status: "ok", coverage: { from: 1, to: 2, complete: true } });
  assert.equal((await store.loadSourceState("g:a:vjudge:default")).status, "ok");
});

test("latest valid submission replaces an older-month copy with the same ID", async () => {
  const store = new Store(new MemoryBackend());
  const old = { ...item("move", "07"), judge: "vjudge", submittedAt: Date.parse("2026-07-31T23:59:00Z"), verdict: "WA", accepted: false };
  const latest = { ...old, submittedAt: Date.parse("2026-08-01T00:01:00Z"), verdict: "AC", accepted: true };
  await store.mergeSubmissions([old]);
  await store.mergeSubmissions([latest]);
  const cached = await store.loadSubmissions();
  assert.deepEqual(cached.map((entry) => entry.submissionId), ["move"]);
  assert.equal(cached[0].submittedAt, latest.submittedAt);
  assert.equal(cached[0].accepted, true);
  assert.deepEqual(await store.get("submission-index", []), ["submissions:a:vjudge:default:2026-08"]);
});

test("corrupt submission chunk does not block a newer valid response", async () => {
  const backend = new MemoryBackend();
  const store = new Store(backend);
  const readable = { ...item("readable", "07"), judge: "vjudge" };
  const readableName = store.monthChunkName(readable);
  const corruptName = "submissions:other:vjudge:default:2026-07";
  await backend.set(store.key("submission-index"), encodeEnvelope([readableName, corruptName]));
  await backend.set(store.key(readableName), encodeEnvelope([readable]));
  const corruptEnvelope = encodeEnvelope([{ ...item("lost", "07"), judge: "vjudge" }]);
  await backend.set(store.key(corruptName), corruptEnvelope.replace(/"checksum":"[^"]+"/, '"checksum":"corrupt"'));
  await store.mergeSubmissions([{ ...item("fresh"), judge: "vjudge" }]);
  assert.deepEqual((await store.loadSubmissions()).map((entry) => entry.submissionId), ["readable", "fresh"]);
  assert.equal(await backend.get(store.key(corruptName)), undefined);
});

test("malformed cached records are ignored while newer valid records remain readable", async () => {
  const backend = new MemoryBackend();
  const store = new Store(backend);
  await backend.set("oj-monitor:v1:submission-index", ["submissions:a:vjudge:default:2026-08"]);
  await backend.set("oj-monitor:v1:submissions:a:vjudge:default:2026-08", [{ broken: true }]);
  await store.mergeSubmissions([{ ...item("valid"), judge: "vjudge" }]);
  assert.deepEqual((await store.loadSubmissions()).map((entry) => entry.submissionId), ["valid"]);
});

test("failed atomic replacement keeps the previously committed value readable", async () => {
  class QuotaBackend extends MemoryBackend {
    constructor() { super(); this.failMainWrite = false; }
    async set(key, value) {
      if (this.failMainWrite && key.endsWith("config")) throw new Error("quota exceeded");
      return super.set(key, value);
    }
  }
  const backend = new QuotaBackend();
  const store = new Store(backend);
  await store.setAtomic("config", { version: "old" });
  backend.failMainWrite = true;
  await assert.rejects(store.setAtomic("config", { version: "new" }), /quota/);
  assert.deepEqual(await store.get("config"), { version: "old" });
});

test("daily stats are upserted by composite identity", async () => {
  const store = new Store(new MemoryBackend());
  const base = { groupId: "g", accountId: "a", judge: "vjudge", scope: "default", date: "2026-08-07", submissionCount: 1, solvedCount: 1 };
  await store.saveDailyStats([base]);
  await store.saveDailyStats([{ ...base, submissionCount: 2 }]);
  assert.equal((await store.loadDailyStats({ groupId: "g" }))[0].submissionCount, 2);
});

test("retention pruning removes expired chunks and keeps overlap data", async () => {
  const store = new Store(new MemoryBackend());
  await store.mergeSubmissions([item("old", "07"), item("new", "08")]);
  await store.pruneSubmissions(Date.parse("2026-08-01T00:00:00Z"));
  assert.deepEqual((await store.loadSubmissions()).map((entry) => entry.submissionId), ["new"]);
  assert.equal((await store.get("submission-index", [])).length, 1);
});
