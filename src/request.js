"use strict";

const { createId, OJMonitorError } = require("./core");

const PAGE_REALM_STATES = new WeakMap();

function parseHeaderText(text = "") {
  const headers = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
}

function responseHeader(response, name) {
  const normalized = name.toLowerCase();
  if (response.headers instanceof Map) return response.headers.get(normalized) || "";
  if (response.headers && typeof response.headers.get === "function") return response.headers.get(name) || "";
  return "";
}

function classifyResponse(response, requestedUrl) {
  const status = Number(response.status || 0);
  const text = String(response.text ?? response.responseText ?? "");
  const finalUrl = String(response.finalUrl || requestedUrl || "");
  const location = responseHeader(response, "location");
  const server = responseHeader(response, "server").toLowerCase();
  const cfMitigated = responseHeader(response, "cf-mitigated").toLowerCase();
  const wsAction = responseHeader(response, "ws-action").toLowerCase();
  const isCloudflare = server.includes("cloudflare") || Boolean(responseHeader(response, "cf-ray"));

  let redirectedUrl = "";
  try {
    redirectedUrl = location ? new URL(location, finalUrl || requestedUrl).href : "";
  } catch {
    redirectedUrl = location;
  }
  if (/\/(?:auth\/)?login(?:[/?#]|$)/i.test(finalUrl) || /\/(?:auth\/)?login(?:[/?#]|$)/i.test(redirectedUrl)) {
    return new OJMonitorError("login-required", "需要先登录目标 OJ", { status, finalUrl });
  }
  if (wsAction === "cc") {
    return new OJMonitorError("verification-required", "目标站点需要浏览器验证", { status, finalUrl, protection: "wangsu" });
  }
  if (
    cfMitigated === "challenge" ||
    /<title>\s*Just a moment/i.test(text) ||
    /\/cdn-cgi\/challenge-platform\//i.test(text) ||
    /turnstile/i.test(text) && /cloudflare/i.test(text)
  ) {
    return new OJMonitorError("verification-required", "Cloudflare 需要浏览器验证", { status, finalUrl, protection: "cloudflare" });
  }
  if (status === 429) return new OJMonitorError("rate-limited", "请求频率过高", { status, finalUrl });
  if (status === 404) return new OJMonitorError("not-found", "用户或数据入口不存在", { status, finalUrl });
  if (status === 401) return new OJMonitorError("login-required", "需要先登录目标 OJ", { status, finalUrl });
  if (status === 403 && isCloudflare) {
    return new OJMonitorError("verification-required", "Cloudflare 拒绝了扩展请求，请在目标站点同源刷新", { status, finalUrl });
  }
  if (status === 403) return new OJMonitorError("permission-denied", "本地账号无权查看该数据", { status, finalUrl });
  if (status >= 400) return new OJMonitorError("network-error", `HTTP ${status}`, { status, finalUrl });
  return null;
}

function isSameOrigin(url, locationObject = globalThis.location) {
  if (!locationObject?.href) return false;
  try {
    return new URL(url, locationObject.href).origin === new URL(locationObject.href).origin;
  } catch {
    return false;
  }
}

function pageFetchBinding(globalObject = globalThis) {
  const lexicalContent = typeof content !== "undefined" ? content : undefined;
  const lexicalUnsafeWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : undefined;
  const candidates = [
    { owner: globalObject.content || lexicalContent, name: "firefox-content-fetch" },
    { owner: globalObject.unsafeWindow || lexicalUnsafeWindow, name: "unsafe-window-fetch" },
    { owner: globalObject.window?.wrappedJSObject, name: "wrapped-window-fetch" },
    { owner: globalObject.window === globalObject ? globalObject : undefined, name: "page-window-fetch" }
  ];
  for (const candidate of candidates) {
    if (candidate.owner && typeof candidate.owner.fetch === "function") {
      return { ...candidate, fetch: candidate.owner.fetch };
    }
  }
  return null;
}

function pageTransportCapability(globalObject = globalThis) {
  const documentObject = globalObject.document;
  const parent = documentObject?.documentElement || documentObject?.head || documentObject?.body;
  const missing = [];
  if (!parent) missing.push("document-root");
  if (typeof documentObject?.createElement !== "function") missing.push("document.createElement");
  if (typeof documentObject?.dispatchEvent !== "function") missing.push("document.dispatchEvent");
  if (typeof globalObject.CustomEvent !== "function") missing.push("CustomEvent");
  if (!missing.length) return { available: true, mode: "page-realm" };
  const binding = pageFetchBinding(globalObject);
  if (binding) {
    return {
      available: true,
      mode: "fallback-binding",
      binding: binding.name,
      pageRealmUnavailable: missing.join(", ")
    };
  }
  return {
    available: false,
    mode: "unavailable",
    reason: `缺少页面请求能力：${missing.join(", ")}`
  };
}

function pageTransportAvailable(globalObject = globalThis) {
  return pageTransportCapability(globalObject).available;
}

function plainHeaders(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => { output[String(name).toLowerCase()] = String(value); });
    return output;
  }
  for (const [name, value] of Object.entries(headers)) output[String(name).toLowerCase()] = String(value);
  return output;
}

function pageRealmCloneFunction(globalObject = globalThis) {
  const lexicalCloneInto = typeof cloneInto === "function" ? cloneInto : undefined;
  if (typeof globalObject.cloneInto === "function") return globalObject.cloneInto;
  return lexicalCloneInto;
}

function pageRealmFetchInit(globalObject, binding, options = {}) {
  const source = {
    method: options.method || "GET",
    headers: plainHeaders(options.headers),
    credentials: "include",
    redirect: options.redirect || "follow"
  };
  if (options.body !== undefined && options.body !== null) source.body = options.body;

  const clone = pageRealmCloneFunction(globalObject);
  if (clone) {
    try {
      return { value: clone(source, binding.owner), mode: "clone-into" };
    } catch {
      // Fall through to constructors from the target page realm. This keeps
      // ordinary GET requests usable even when a body cannot be cloned.
    }
  }

  const PageObject = binding.owner?.Object;
  const target = typeof PageObject === "function" ? new PageObject() : {};
  target.method = source.method;
  target.credentials = source.credentials;
  target.redirect = source.redirect;
  if (source.body !== undefined) target.body = source.body;
  const PageHeaders = binding.owner?.Headers;
  if (typeof PageHeaders === "function") {
    const headers = new PageHeaders();
    for (const [name, value] of Object.entries(source.headers)) headers.append(name, value);
    target.headers = headers;
  } else {
    const HeadersObject = typeof PageObject === "function" ? new PageObject() : {};
    for (const [name, value] of Object.entries(source.headers)) HeadersObject[name] = value;
    target.headers = HeadersObject;
  }
  return { value: target, mode: typeof PageObject === "function" ? "page-constructors" : "direct" };
}

function gmCookiePartitionOptions(options = {}) {
  // cookiePartition selects a partitioned-cookie jar; it is not a generic
  // "send cookies" switch. Leave Tampermonkey's normal cookie jar untouched
  // unless a caller explicitly supplies a partition key.
  return options.cookiePartition && typeof options.cookiePartition === "object"
    ? { cookiePartition: options.cookiePartition }
    : {};
}

// This function is serialized into a <script> element. Keep it self-contained.
function installPageRealmEndpoint(documentObject, windowObject, events) {
  if (windowObject[events.marker]) {
    documentObject.dispatchEvent(new windowObject.CustomEvent(events.ready));
    return;
  }
  Object.defineProperty(windowObject, events.marker, { value: true, configurable: false });
  const controllers = new Map();
  const reply = (payload) => documentObject.dispatchEvent(new windowObject.CustomEvent(events.response, {
    detail: JSON.stringify(payload)
  }));
  documentObject.addEventListener(events.cancel, (event) => {
    try {
      const payload = JSON.parse(String(event.detail || ""));
      controllers.get(payload.id)?.abort();
    } catch {
      // Ignore malformed or unrelated page events.
    }
  });
  documentObject.addEventListener(events.request, async (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.detail || ""));
      const url = new URL(payload.url, windowObject.location.href);
      if (url.origin !== windowObject.location.origin || payload.method !== "GET") {
        throw new Error("OJ Monitor page request rejected");
      }
      const allowedHeaders = {};
      for (const [name, value] of Object.entries(payload.headers || {})) {
        const normalized = String(name).toLowerCase();
        if (["accept", "content-type", "x-lentille-request", "x-luogu-type", "x-requested-with"].includes(normalized)) {
          allowedHeaders[normalized] = String(value);
        }
      }
      const Controller = windowObject.AbortController;
      const controller = new Controller();
      controllers.set(payload.id, controller);
      const response = await windowObject.fetch(url.href, {
        method: "GET",
        headers: allowedHeaders,
        credentials: "include",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      });
      const headers = [];
      response.headers.forEach((value, name) => headers.push([String(name).toLowerCase(), String(value)]));
      reply({
        id: payload.id,
        ok: true,
        status: response.status,
        finalUrl: response.url || url.href,
        headers,
        text: await response.text()
      });
    } catch (error) {
      if (payload?.id) {
        reply({ id: payload.id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (payload?.id) controllers.delete(payload.id);
    }
  });
  documentObject.dispatchEvent(new windowObject.CustomEvent(events.ready));
}

function installPageRealmBridge(globalObject = globalThis) {
  if (PAGE_REALM_STATES.has(globalObject)) return PAGE_REALM_STATES.get(globalObject);
  const documentObject = globalObject.document;
  const parent = documentObject?.documentElement || documentObject?.head || documentObject?.body;
  if (!parent || typeof documentObject.createElement !== "function" || typeof documentObject.dispatchEvent !== "function") {
    throw new OJMonitorError("source-unavailable", "当前页面尚不能安装主世界请求代理");
  }
  const channel = createId("page-realm").replace(/[^a-zA-Z0-9_-]/g, "");
  const events = {
    marker: `__OJMON_PAGE_REALM_${channel}`,
    ready: `ojmon:${channel}:ready`,
    request: `ojmon:${channel}:request`,
    response: `ojmon:${channel}:response`,
    cancel: `ojmon:${channel}:cancel`
  };
  let ready = false;
  const onReady = () => { ready = true; };
  documentObject.addEventListener(events.ready, onReady);
  const script = documentObject.createElement("script");
  script.textContent = `;(${installPageRealmEndpoint.toString()})(document, window, ${JSON.stringify(events)});`;
  parent.appendChild(script);
  script.remove?.();
  documentObject.removeEventListener(events.ready, onReady);
  if (!ready) {
    throw new OJMonitorError("source-unavailable", "页面主世界请求代理被 CSP 或用户脚本环境阻止");
  }
  const state = { document: documentObject, events };
  PAGE_REALM_STATES.set(globalObject, state);
  return state;
}

function pageRealmRequest(globalObject, url, options = {}) {
  const state = installPageRealmBridge(globalObject);
  const EventConstructor = globalObject.CustomEvent;
  if (typeof EventConstructor !== "function") {
    throw new OJMonitorError("source-unavailable", "当前页面缺少 CustomEvent，无法使用主世界请求代理");
  }
  const id = createId("page-request");
  const timeout = Number.isFinite(options.timeout) ? Math.max(1, options.timeout) : 30000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      state.document.removeEventListener(state.events.response, onResponse);
      options.signal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const dispatchCancel = () => state.document.dispatchEvent(new EventConstructor(state.events.cancel, {
      detail: JSON.stringify({ id })
    }));
    const onAbort = () => {
      dispatchCancel();
      settle(reject, new OJMonitorError("network-error", "页面主世界请求已取消"));
    };
    const onResponse = (event) => {
      let response;
      try {
        response = JSON.parse(String(event.detail || ""));
      } catch {
        return;
      }
      if (response.id !== id) return;
      if (!response.ok) {
        settle(reject, new OJMonitorError("network-error", response.message || "页面主世界请求失败"));
        return;
      }
      settle(resolve, {
        status: response.status,
        finalUrl: response.finalUrl || url,
        headers: new Map(response.headers || []),
        text: response.text ?? "",
        transport: "page-realm-fetch"
      });
    };
    state.document.addEventListener(state.events.response, onResponse);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      dispatchCancel();
      settle(reject, new OJMonitorError("network-error", "页面主世界请求超时"));
    }, timeout);
    state.document.dispatchEvent(new EventConstructor(state.events.request, {
      detail: JSON.stringify({
        id,
        url: String(url),
        method: options.method || "GET",
        headers: plainHeaders(options.headers)
      })
    }));
  });
}

function gmRequest(globalObject, options) {
  // Derived from OJBetter's GPL-3.0 OJB_GMRequest settle-once Promise wrapper.
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const { signal, ...transportOptions } = options;
    const requestOptions = {
      ...transportOptions,
      onload: (response) => settle(resolve, response),
      onerror: (error) => settle(reject, new OJMonitorError("network-error", "跨域请求失败", error)),
      ontimeout: (error) => settle(reject, new OJMonitorError("network-error", "请求超时", error)),
      onabort: (error) => settle(reject, new OJMonitorError("network-error", "请求已取消", error))
    };
    try {
      request = globalObject.GM_xmlhttpRequest(requestOptions);
    } catch (error) {
      settle(reject, error);
    }
    if (signal) {
      if (signal.aborted) {
        request?.abort?.();
        settle(reject, new OJMonitorError("network-error", "请求已取消"));
      } else signal.addEventListener("abort", () => request?.abort?.(), { once: true });
    }
  });
}

class HttpClient {
  constructor(options = {}) {
    this.global = options.globalObject || globalThis;
    this.transport = options.transport || null;
    this.siteBridge = options.siteBridge || null;
    this.beforeRequest = options.beforeRequest || null;
    this.timeout = options.timeout || 30000;
    this.onRetry = options.onRetry || null;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async request(url, options = {}) {
    const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 2;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(url, options);
      } catch (error) {
        if (error.status !== "network-error" || options.signal?.aborted || attempt >= retries) throw error;
        if (this.onRetry) await this.onRetry(url, attempt + 1, error);
        await this.sleep(Math.min(4000, 500 * (2 ** attempt)));
      }
    }
  }

  async requestOnce(url, options = {}) {
    if (this.beforeRequest) await this.beforeRequest(url, options);
    let response;
    try {
      if (this.transport) {
        response = await this.transport(url, options);
      } else if (options.transport === "site-bridge") {
        if (!this.siteBridge) throw new OJMonitorError("source-unavailable", "跨标签页请求代理尚未启动");
        response = await this.siteBridge.request(url, options);
      } else if (options.transport === "page-fetch") {
        if (!isSameOrigin(url, this.global.location)) {
          throw new OJMonitorError("source-unavailable", "页面请求只能访问当前标签页的同源地址");
        }
        try {
          response = await pageRealmRequest(this.global, url, { ...options, timeout: options.timeout || this.timeout });
        } catch (pageError) {
          if (pageError.status !== "source-unavailable") throw pageError;
          const binding = pageFetchBinding(this.global);
          if (!binding) throw pageError;
          const transfer = pageRealmFetchInit(this.global, binding, options);
          const fetchResponse = await Reflect.apply(binding.fetch, binding.owner, [url, transfer.value]);
          response = {
            status: fetchResponse.status,
            finalUrl: fetchResponse.url,
            headers: fetchResponse.headers,
            text: await fetchResponse.text(),
            transport: binding.name,
            transportFallback: {
              requested: "page-realm-fetch",
              status: pageError.status,
              reason: pageError.message,
              realmTransfer: transfer.mode
            }
          };
        }
      } else if (options.transport === "gm-xhr" && typeof this.global.GM_xmlhttpRequest === "function") {
        const gmResponse = await gmRequest(this.global, {
          method: options.method || "GET",
          url,
          headers: options.headers,
          data: options.body,
          redirect: options.redirect || "follow",
          ...gmCookiePartitionOptions(options),
          timeout: options.timeout || this.timeout,
          signal: options.signal,
          responseType: "text"
        });
        response = {
          status: gmResponse.status,
          finalUrl: gmResponse.finalUrl || url,
          headers: parseHeaderText(gmResponse.responseHeaders),
          text: gmResponse.responseText ?? gmResponse.response ?? "",
          transport: "gm-xhr"
        };
      } else if (isSameOrigin(url, this.global.location) && typeof this.global.fetch === "function") {
        const fetchResponse = await this.global.fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
          credentials: "include",
          signal: options.signal,
          redirect: options.redirect || "follow"
        });
        response = {
          status: fetchResponse.status,
          finalUrl: fetchResponse.url,
          headers: fetchResponse.headers,
          text: await fetchResponse.text(),
          transport: "same-origin-fetch"
        };
      } else if (typeof this.global.GM_xmlhttpRequest === "function") {
        const gmResponse = await gmRequest(this.global, {
          method: options.method || "GET",
          url,
          headers: options.headers,
          data: options.body,
          redirect: options.redirect || "follow",
          ...gmCookiePartitionOptions(options),
          timeout: options.timeout || this.timeout,
          signal: options.signal,
          responseType: "text"
        });
        response = {
          status: gmResponse.status,
          finalUrl: gmResponse.finalUrl || url,
          headers: parseHeaderText(gmResponse.responseHeaders),
          text: gmResponse.responseText ?? gmResponse.response ?? "",
          transport: "gm-xhr"
        };
      } else if (typeof this.global.fetch === "function") {
        const fetchResponse = await this.global.fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
          credentials: "include",
          signal: options.signal,
          redirect: options.redirect || "follow"
        });
        response = { status: fetchResponse.status, finalUrl: fetchResponse.url, headers: fetchResponse.headers, text: await fetchResponse.text(), transport: "fetch-fallback" };
      } else {
        throw new OJMonitorError("network-error", "没有可用的浏览器请求能力");
      }
    } catch (error) {
      if (error instanceof OJMonitorError) throw error;
      throw new OJMonitorError("network-error", "请求失败", { url, cause: error });
    }
    const error = classifyResponse(response, url);
    if (error) {
      error.details = {
        ...(error.details || {}),
        transport: response.transport,
        httpStatus: Number.isFinite(Number(response.status)) ? Number(response.status) : undefined,
        transportFallback: response.transportFallback
      };
      throw error;
    }
    return response;
  }

  async json(url, options = {}) {
    const response = await this.request(url, options);
    try {
      return { data: JSON.parse(response.text), response };
    } catch (error) {
      throw new OJMonitorError("schema-changed", "响应不是有效 JSON", { url, cause: error, contentType: responseHeader(response, "content-type") });
    }
  }
}

module.exports = {
  HttpClient,
  classifyResponse,
  gmRequest,
  installPageRealmBridge,
  installPageRealmEndpoint,
  isSameOrigin,
  pageFetchBinding,
  pageRealmFetchInit,
  pageTransportCapability,
  pageTransportAvailable,
  pageRealmRequest,
  parseHeaderText,
  plainHeaders,
  gmCookiePartitionOptions,
  responseHeader
};
