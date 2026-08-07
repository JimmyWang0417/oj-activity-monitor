"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DomainRateLimiter, LeaseCoordinator } = require("../src/scheduler");
const { MemoryBackend, Store } = require("../src/storage");

test("lease excludes another owner until expiry", async () => {
  let now = 1000;
  const store = new Store(new MemoryBackend());
  const options = { clock: () => now, sleep: async () => {}, random: () => 0 };
  const first = new LeaseCoordinator(store, { ...options, ownerId: "one" });
  const second = new LeaseCoordinator(store, { ...options, ownerId: "two" });
  const lease = await first.acquire("refresh", { ttl: 100, attempts: 1 });
  assert.equal(lease.ownerId, "one");
  assert.equal(await second.acquire("refresh", { ttl: 100, attempts: 1 }), null);
  now = 1101;
  assert.equal((await second.acquire("refresh", { ttl: 100, attempts: 1 })).ownerId, "two");
});

test("lease waiter observes shared completion or automatically reaches expired ownership", async () => {
  let now = 1000;
  let completed = false;
  const store = new Store(new MemoryBackend());
  const first = new LeaseCoordinator(store, { ownerId: "one", clock: () => now, sleep: async () => {}, random: () => 0 });
  await first.acquire("refresh", { ttl: 100, attempts: 1 });
  const second = new LeaseCoordinator(store, {
    ownerId: "two",
    clock: () => now,
    sleep: async (milliseconds) => { now += milliseconds; completed = true; },
    random: () => 0
  });
  const shared = await second.waitForRelease("refresh", { pollInterval: 10, isComplete: async () => completed && { at: now } });
  assert.equal(shared.reason, "completed");
  assert.equal(shared.value.at, 1010);

  completed = false;
  now = 1000;
  const available = await second.waitForRelease("refresh", { pollInterval: 25, timeout: 200, isComplete: async () => false });
  assert.equal(available.reason, "available");
  assert.equal(now, 1100);
});

test("domain limiter serializes callers and removes completed queue", async () => {
  let now = 1000;
  const sleeps = [];
  const limiter = new DomainRateLimiter(new Store(new MemoryBackend()), {
    clock: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; }
  });
  await Promise.all([limiter.waitTurn("api", 100), limiter.waitTurn("api", 100)]);
  assert.deepEqual(sleeps, [100]);
  assert.equal(limiter.chains.size, 0);
});
