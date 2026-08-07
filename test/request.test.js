"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HttpClient, classifyResponse, isSameOrigin, pageFetchBinding, pageTransportAvailable, pageTransportCapability, parseHeaderText } = require("../src/request");

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
      appendChild: (script) => {
        Function("document", "window", script.textContent)(this, this.pageWindow);
      }
    };
  }

  createElement() {
    return { textContent: "", remove() {} };
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return true;
  }
}

test("response classification distinguishes login, protection and rate limit", () => {
  assert.equal(classifyResponse({ status: 200, finalUrl: "https://www.luogu.com.cn/auth/login", text: "" }).status, "login-required");
  assert.equal(classifyResponse({ status: 200, finalUrl: "https://qoj.ac/login", text: "" }).status, "login-required");
  assert.equal(classifyResponse({ status: 403, headers: parseHeaderText("server: cloudflare\r\ncf-ray: 1"), text: "" }).status, "verification-required");
  assert.equal(classifyResponse({ status: 200, headers: parseHeaderText("ws-action: cc"), text: "" }).status, "verification-required");
  assert.equal(classifyResponse({ status: 302, finalUrl: "https://www.luogu.com.cn/record/list", headers: parseHeaderText("location: /auth/login"), text: "<html>" }).status, "login-required");
  assert.equal(classifyResponse({ status: 429, text: "" }).status, "rate-limited");
});

test("GM requests keep the default cookie jar unless a partition is explicitly requested", async () => {
  let requestDetails;
  const globalObject = {
    location: { href: "https://codeforces.com/problemset" },
    GM_xmlhttpRequest(details) {
      requestDetails = details;
      queueMicrotask(() => details.onload({ status: 200, finalUrl: details.url, responseHeaders: "content-type: text/plain", responseText: "ok" }));
      return { abort() {} };
    }
  };
  const client = new HttpClient({ globalObject });
  await client.request("https://qoj.ac/submissions");
  assert.equal(requestDetails.redirect, "follow");
  assert.equal(requestDetails.cookiePartition, undefined);
  await client.request("https://qoj.ac/submissions", { cookiePartition: { topLevelSite: "https://qoj.ac" } });
  assert.deepEqual(requestDetails.cookiePartition, { topLevelSite: "https://qoj.ac" });
});

test("forced GM transport wins over same-origin fetch for Firefox session fallbacks", async () => {
  let used = "";
  const globalObject = {
    location: { href: "https://www.luogu.com.cn/" },
    fetch: async () => { used = "fetch"; throw new Error("must not run"); },
    GM_xmlhttpRequest(details) {
      used = "gm-xhr";
      queueMicrotask(() => details.onload({ status: 200, finalUrl: details.url, responseHeaders: "content-type: application/json", responseText: "{}" }));
      return { abort() {} };
    }
  };
  const client = new HttpClient({ globalObject });
  const response = await client.request("https://www.luogu.com.cn/record/list?user=1&page=1", { transport: "gm-xhr" });
  assert.equal(used, "gm-xhr");
  assert.equal(response.transport, "gm-xhr");
});

test("page transport injects a restricted fetch into the actual page realm", async () => {
  let pageOptions;
  const responseBody = JSON.stringify({ currentData: { records: { count: 0, result: [] } } });
  const pageWindow = {
    location: { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn" },
    AbortController,
    CustomEvent: FakeCustomEvent,
    fetch: async (url, options) => {
      pageOptions = options;
      return { status: 200, url, headers: new Map([["content-type", "application/json"]]), text: async () => responseBody };
    }
  };
  const globalObject = {
    location: pageWindow.location,
    document: new FakeDocument(pageWindow),
    CustomEvent: FakeCustomEvent,
    content: { fetch: async () => { throw new Error("extension fetch must not run"); } }
  };
  const client = new HttpClient({ globalObject });
  const response = await client.request("https://www.luogu.com.cn/record/list?user=1&page=1", {
    transport: "page-fetch",
    headers: { "x-luogu-type": "content-only", "x-requested-with": "XMLHttpRequest", authorization: "must-be-dropped" }
  });
  assert.equal(response.transport, "page-realm-fetch");
  assert.equal(response.text, responseBody);
  assert.equal(pageOptions.credentials, "include");
  assert.equal(pageOptions.headers["x-luogu-type"], "content-only");
  assert.equal(pageOptions.headers["x-requested-with"], "XMLHttpRequest");
  assert.equal(pageOptions.headers.authorization, undefined);
});

test("page realm transport remains available without Firefox content.fetch", () => {
  const pageWindow = {
    location: { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn" },
    AbortController,
    CustomEvent: FakeCustomEvent,
    fetch: async () => { throw new Error("not called"); }
  };
  const globalObject = {
    location: pageWindow.location,
    document: new FakeDocument(pageWindow),
    CustomEvent: FakeCustomEvent
  };
  assert.equal(pageFetchBinding(globalObject), null);
  assert.equal(pageTransportAvailable(globalObject), true);
  assert.deepEqual(pageTransportCapability(globalObject), { available: true, mode: "page-realm" });
});

test("page transport capability explains why no page request can be attempted", () => {
  assert.deepEqual(pageTransportCapability({}), {
    available: false,
    mode: "unavailable",
    reason: "缺少页面请求能力：document-root, document.createElement, document.dispatchEvent, CustomEvent"
  });
});

test("page realm login redirect keeps its actual transport for diagnostics", async () => {
  const pageWindow = {
    location: { href: "https://www.luogu.com.cn/", origin: "https://www.luogu.com.cn" },
    AbortController,
    CustomEvent: FakeCustomEvent,
    fetch: async () => ({
      status: 200,
      url: "https://www.luogu.com.cn/auth/login",
      headers: new Map([["content-type", "application/json"]]),
      text: async () => JSON.stringify({ instance: "auth", template: "login" })
    })
  };
  const client = new HttpClient({
    globalObject: {
      location: pageWindow.location,
      document: new FakeDocument(pageWindow),
      CustomEvent: FakeCustomEvent
    }
  });
  await assert.rejects(
    client.request("https://www.luogu.com.cn/record/list?user=1&page=1", { transport: "page-fetch" }),
    (error) => error.status === "login-required" &&
      error.details?.transport === "page-realm-fetch" &&
      error.details?.httpStatus === 200 &&
      error.details?.finalUrl === "https://www.luogu.com.cn/auth/login"
  );
});

test("plain fetch fallback explicitly includes credentials", async () => {
  let fetchOptions;
  const client = new HttpClient({
    globalObject: {
      location: { href: "https://atcoder.jp/", origin: "https://atcoder.jp" },
      fetch: async (url, options) => {
        fetchOptions = options;
        return { status: 200, url, headers: new Map(), text: async () => "ok" };
      }
    }
  });
  const response = await client.request("https://www.luogu.com.cn/api/user/search?keyword=user");
  assert.equal(response.transport, "fetch-fallback");
  assert.equal(fetchOptions.credentials, "include");
  assert.equal(fetchOptions.redirect, "follow");
});

test("page transport uses Firefox content.fetch instead of extension fetch", async () => {
  let used = "";
  let receivedOptions;
  let contentOwner;
  const responseBody = JSON.stringify({ currentData: { records: { count: 0, result: [] } } });
  const globalObject = {
    location: { href: "https://www.luogu.com.cn/record/list", origin: "https://www.luogu.com.cn" },
    fetch: async () => { used = "extension-fetch"; throw new Error("must not run"); },
    content: contentOwner = {
      fetch: async (_url, options) => {
        used = "firefox-content-fetch";
        receivedOptions = options;
        return { status: 200, url: "https://www.luogu.com.cn/record/list", headers: new Map(), text: async () => responseBody };
      }
    },
    cloneInto(value, owner) {
      assert.equal(owner, contentOwner);
      return { ...value, clonedForPage: true };
    }
  };
  assert.equal(pageFetchBinding(globalObject).name, "firefox-content-fetch");
  const client = new HttpClient({ globalObject });
  const response = await client.request("https://www.luogu.com.cn/record/list?user=1&page=1", { transport: "page-fetch" });
  assert.equal(used, "firefox-content-fetch");
  assert.equal(receivedOptions.credentials, "include");
  assert.equal(receivedOptions.clonedForPage, true);
  assert.equal(response.transport, "firefox-content-fetch");
  assert.deepEqual(response.transportFallback, {
    requested: "page-realm-fetch",
    status: "source-unavailable",
    reason: "当前页面尚不能安装主世界请求代理",
    realmTransfer: "clone-into"
  });
  assert.equal(response.text, responseBody);
});

test("same-origin detection handles relative and cross-origin URLs", () => {
  const location = { href: "https://atcoder.jp/home" };
  assert.equal(isSameOrigin("/users/a", location), true);
  assert.equal(isSameOrigin("https://kenkoooo.com/api/", location), false);
});

test("HTTP client validates JSON and wraps network failures", async () => {
  const valid = new HttpClient({ transport: async () => ({ status: 200, text: '{"ok":true}', headers: new Map() }) });
  assert.deepEqual((await valid.json("https://example.com")).data, { ok: true });
  const invalid = new HttpClient({ transport: async () => ({ status: 200, text: "<html>", headers: new Map() }) });
  await assert.rejects(invalid.json("https://example.com"), (error) => error.status === "schema-changed");
  let attempts = 0;
  const broken = new HttpClient({ transport: async () => { attempts += 1; throw new TypeError("offline"); }, sleep: async () => {} });
  await assert.rejects(broken.request("https://example.com"), (error) => error.status === "network-error");
  assert.equal(attempts, 3);
});
