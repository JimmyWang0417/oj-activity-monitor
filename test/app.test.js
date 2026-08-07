"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OJMonitorApplication } = require("../src/app");

function applicationFixture(overrides = {}) {
  const app = Object.create(OJMonitorApplication.prototype);
  app.abortController = null;
  app.store = overrides.store || {
    loadConfig: async () => ({ groups: [], settings: {} }),
    get: async () => null
  };
  app.lease = overrides.lease;
  app.service = overrides.service || { refresh: async () => ({ results: [] }) };
  return app;
}

test("application refresh returns a completed shared result instead of staying in lease wait", async () => {
  const events = [];
  const sharedResult = { at: 2000, incompleteCount: 2 };
  const app = applicationFixture({
    lease: {
      runExclusive: async () => ({ acquired: false }),
      waitForRelease: async (_name, options) => {
        assert.equal(options.timeout, 30 * 60 * 1000);
        return { reason: "completed", value: sharedResult };
      }
    }
  });

  const response = await app.refresh((event) => events.push(event));
  assert.deepEqual(response, { acquired: false, shared: true, value: sharedResult });
  assert.deepEqual(events, [
    { type: "lease-wait" },
    { type: "shared-complete", lastRefresh: sharedResult }
  ]);
  assert.equal(app.abortController, null);
});

test("application refresh takes over after the previous lease expires", async () => {
  const events = [];
  const ownResult = { results: [{ status: "ok" }] };
  let exclusiveCalls = 0;
  let serviceCalls = 0;
  const app = applicationFixture({
    lease: {
      runExclusive: async (_name, task) => {
        exclusiveCalls += 1;
        if (exclusiveCalls === 1) return { acquired: false };
        return { acquired: true, value: await task() };
      },
      waitForRelease: async () => ({ reason: "available" })
    },
    service: {
      refresh: async () => {
        serviceCalls += 1;
        return ownResult;
      }
    }
  });

  const response = await app.refresh((event) => events.push(event));
  assert.deepEqual(response, { acquired: true, value: ownResult });
  assert.equal(exclusiveCalls, 2);
  assert.equal(serviceCalls, 1);
  assert.deepEqual(events, [{ type: "lease-wait" }, { type: "lease-takeover" }]);
  assert.equal(app.abortController, null);
});
