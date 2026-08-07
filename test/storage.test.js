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
