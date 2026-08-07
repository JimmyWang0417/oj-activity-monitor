"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HttpClient } = require("../src/request");
const { SiteSessionBridge, allowedBridgeUrl, siteFromUrl, workerSiteFromLocation } = require("../src/site-bridge");
const { MemoryBackend, Store } = require("../src/storage");

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

class FakeDocument {
  constructor(pageWindow) {
    this.pageWindow = pageWindow;
    this.listeners = new Map();
    this.documentElement = {
      appendChild: (script) => Function("document", "window", script.textContent)(this, this.pageWindow)
    };
  }

  createElement() { return { textContent: "", remove() {} }; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return true;
  }
}

test("site bridge sends a cross-page QOJ request through the open QOJ tab", async () => {
  const store = new Store(new MemoryBackend());
  const fetchedUrls = [];
  const fetchOptions = [];
  const targetGlobal = {
    location: { href: "https://qoj.ac/", origin: "https://qoj.ac", hostname: "qoj.ac" },
    content: {
      fetch: async (url, options) => {
        fetchedUrls.push(url);
        fetchOptions.push(options);
        return {
          status: 200,
          url,
          headers: new Map([["content-type", "text/html"]]),
          text: async () => `QOJ page session: ${new URL(url).pathname}`
        };
      }
    }
  };
  const targetBridge = new SiteSessionBridge({ store, globalObject: targetGlobal, pollInterval: 1 });
  const targetClient = new HttpClient({ globalObject: targetGlobal, siteBridge: targetBridge });
  targetBridge.client = targetClient;
  await targetBridge.start();

  const requesterGlobal = {
    location: { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn", hostname: "www.luogu.com.cn" }
  };
  const requesterBridge = new SiteSessionBridge({ store, globalObject: requesterGlobal, pollInterval: 1 });
  const requesterClient = new HttpClient({ globalObject: requesterGlobal, siteBridge: requesterBridge });
  requesterBridge.client = requesterClient;
  try {
    const [profile, submissions] = await Promise.all([
      requesterClient.request("https://qoj.ac/user/profile/alice", { transport: "site-bridge" }),
      requesterClient.request("https://qoj.ac/submissions?submitter=alice&page=1", { transport: "site-bridge" })
    ]);
    assert.equal(profile.text, "QOJ page session: /user/profile/alice");
    assert.equal(submissions.text, "QOJ page session: /submissions");
    assert.equal(profile.transport, "site-tab:firefox-content-fetch");
    assert.deepEqual(fetchedUrls, [
      "https://qoj.ac/user/profile/alice",
      "https://qoj.ac/submissions?submitter=alice&page=1"
    ]);
    assert.equal(fetchOptions[0].credentials, "include");
    assert.equal(fetchOptions[1].credentials, "include");
  } finally {
    await targetBridge.stop();
  }
});

test("site bridge reports a missing target tab immediately and rejects unrelated paths", async () => {
  const store = new Store(new MemoryBackend());
  const globalObject = { location: { href: "https://atcoder.jp/", origin: "https://atcoder.jp", hostname: "atcoder.jp" } };
  const bridge = new SiteSessionBridge({ store, globalObject, pollInterval: 1 });
  await assert.rejects(
    bridge.request("https://qoj.ac/submissions?submitter=alice"),
    (error) => error.status === "source-unavailable" && /QOJ标签页/.test(error.message)
  );
  assert.equal(siteFromUrl("https://www.luogu.com.cn/record/list"), "luogu");
  assert.equal(workerSiteFromLocation({ href: "https://www.luogu.com.cn/" }), "luogu");
  assert.equal(workerSiteFromLocation({ href: "https://luogu.com.cn/" }), null);
  assert.throws(
    () => allowedBridgeUrl("qoj", "https://qoj.ac/admin", globalObject.location.href),
    (error) => error.status === "permission-denied"
  );
});

test("cross-page Luogu request reaches the www tab's page realm instead of the extension realm", async () => {
  const store = new Store(new MemoryBackend());
  const location = { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn", hostname: "www.luogu.com.cn" };
  const pageWindow = {
    location,
    AbortController,
    CustomEvent: FakeCustomEvent,
    fetch: async (url, options) => ({
      status: 200,
      url,
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({
        pageRealm: true,
        credentials: options.credentials,
        luoguType: options.headers["x-luogu-type"]
      })
    })
  };
  const targetGlobal = {
    location,
    document: new FakeDocument(pageWindow),
    CustomEvent: FakeCustomEvent,
    content: { fetch: async () => { throw new Error("extension realm must not run"); } }
  };
  const targetBridge = new SiteSessionBridge({ store, globalObject: targetGlobal, pollInterval: 1 });
  const targetClient = new HttpClient({ globalObject: targetGlobal, siteBridge: targetBridge });
  targetBridge.client = targetClient;
  await targetBridge.start();

  const requesterGlobal = { location: { href: "https://atcoder.jp/", origin: "https://atcoder.jp", hostname: "atcoder.jp" } };
  const requesterBridge = new SiteSessionBridge({ store, globalObject: requesterGlobal, pollInterval: 1 });
  const requesterClient = new HttpClient({ globalObject: requesterGlobal, siteBridge: requesterBridge });
  requesterBridge.client = requesterClient;
  try {
    const response = await requesterClient.request("https://www.luogu.com.cn/record/list?user=1&page=1", {
      transport: "site-bridge",
      headers: { "x-luogu-type": "content-only" }
    });
    assert.equal(response.transport, "site-tab:page-realm-fetch");
    assert.deepEqual(JSON.parse(response.text), {
      pageRealm: true,
      credentials: "include",
      luoguType: "content-only"
    });
  } finally {
    await targetBridge.stop();
  }
});

test("cross-page Luogu login redirect reports the worker's actual page-realm transport", async () => {
  const store = new Store(new MemoryBackend());
  const location = { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn", hostname: "www.luogu.com.cn" };
  const pageWindow = {
    location,
    AbortController,
    CustomEvent: FakeCustomEvent,
    fetch: async () => ({
      status: 200,
      url: "https://www.luogu.com.cn/auth/login",
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ instance: "auth", template: "login" })
    })
  };
  const targetGlobal = { location, document: new FakeDocument(pageWindow), CustomEvent: FakeCustomEvent };
  const targetBridge = new SiteSessionBridge({ store, globalObject: targetGlobal, pollInterval: 1 });
  const targetClient = new HttpClient({ globalObject: targetGlobal, siteBridge: targetBridge });
  targetBridge.client = targetClient;
  await targetBridge.start();

  const requesterGlobal = { location: { href: "https://atcoder.jp/", origin: "https://atcoder.jp", hostname: "atcoder.jp" } };
  const requesterBridge = new SiteSessionBridge({ store, globalObject: requesterGlobal, pollInterval: 1 });
  try {
    await assert.rejects(
      requesterBridge.request("https://www.luogu.com.cn/record/list?user=1&page=1"),
      (error) => error.status === "login-required" &&
        error.details?.transport === "site-tab:page-realm-fetch" &&
        error.details?.httpStatus === 200 &&
        error.details?.finalUrl === "https://www.luogu.com.cn/auth/login"
    );
  } finally {
    await targetBridge.stop();
  }
});
