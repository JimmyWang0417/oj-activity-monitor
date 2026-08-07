"use strict";

const { createId, OJMonitorError } = require("./core");

const SITE_LABELS = Object.freeze({ luogu: "洛谷 www.luogu.com.cn", qoj: "QOJ" });
const ALLOWED_PATHS = Object.freeze({
  luogu: [/^\/record\/list$/, /^\/api\/user\/search$/, /^\/user\/[^/]+$/],
  qoj: [/^\/submissions$/, /^\/user\/profile\/[^/]+$/]
});

function siteFromUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:") return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === "qoj.ac") return "qoj";
    if (hostname === "luogu.com.cn" || hostname.endsWith(".luogu.com.cn")) return "luogu";
  } catch {
    return null;
  }
  return null;
}

function workerSiteFromLocation(locationObject) {
  try {
    const url = new URL(locationObject?.href);
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() === "qoj.ac") return "qoj";
    if (url.hostname.toLowerCase() === "www.luogu.com.cn") return "luogu";
  } catch {
    return null;
  }
  return null;
}

function allowedBridgeUrl(site, value, base) {
  const url = new URL(value, base);
  if (siteFromUrl(url.href) !== site || !ALLOWED_PATHS[site]?.some((pattern) => pattern.test(url.pathname))) {
    throw new OJMonitorError("permission-denied", "跨标签页请求地址不在允许范围内");
  }
  return url;
}

function headerObject(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => { output[String(name).toLowerCase()] = String(value); });
    return output;
  }
  for (const [name, value] of Object.entries(headers)) output[String(name).toLowerCase()] = String(value);
  return output;
}

function headerEntries(headers) {
  const output = [];
  if (!headers) return output;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, name) => output.push([String(name).toLowerCase(), String(value)]));
  } else {
    for (const [name, value] of Object.entries(headers)) output.push([String(name).toLowerCase(), String(value)]);
  }
  return output;
}

class SiteSessionBridge {
  constructor(options) {
    this.store = options.store;
    this.global = options.globalObject || globalThis;
    this.client = options.client || null;
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.timeout = options.timeout || 45000;
    this.pollInterval = options.pollInterval || 100;
    this.presenceMaxAge = options.presenceMaxAge || 15000;
    this.workerId = createId("site-tab");
    this.site = workerSiteFromLocation(this.global.location);
    this.listenerId = null;
    this.heartbeatId = null;
    this.processing = new Set();
    this.chains = new Map();
  }

  presenceName(site) {
    return `site-bridge:presence:${site}`;
  }

  requestName(site) {
    return `site-bridge:request:${site}`;
  }

  responseName(id) {
    return `site-bridge:response:${id}`;
  }

  async publishPresence() {
    if (!this.site) return;
    await this.store.setAtomic(this.presenceName(this.site), {
      workerId: this.workerId,
      site: this.site,
      at: this.clock()
    });
  }

  async start() {
    if (!this.site || this.listenerId !== null) return this;
    await this.publishPresence();
    this.listenerId = this.store.watch(this.requestName(this.site), (request, _old, _remote, error) => {
      if (!error && request?.id) this.handleRequest(request).catch(() => undefined);
    });
    const pending = await this.store.get(this.requestName(this.site), null);
    if (pending?.id) this.handleRequest(pending).catch(() => undefined);
    this.heartbeatId = setInterval(() => this.publishPresence().catch(() => undefined), 5000);
    return this;
  }

  async stop() {
    if (this.heartbeatId !== null) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    if (this.listenerId !== null) this.store.unwatch(this.listenerId);
    this.listenerId = null;
    const current = this.site ? await this.store.get(this.presenceName(this.site), null) : null;
    if (current?.workerId === this.workerId) await this.store.delete(this.presenceName(this.site));
  }

  async handleRequest(request) {
    if (!this.site || !this.client || this.processing.has(request.id)) return;
    if (this.clock() - Number(request.createdAt || 0) > this.timeout) return;
    this.processing.add(request.id);
    try {
      const requestedUrl = allowedBridgeUrl(this.site, request.url, this.global.location?.href);
      const localUrl = new URL(`${requestedUrl.pathname}${requestedUrl.search}`, this.global.location.origin).href;
      const response = await this.client.request(localUrl, {
        method: request.method || "GET",
        headers: request.headers || {},
        transport: "page-fetch",
        retries: 0
      });
      const pending = await this.store.get(this.requestName(this.site), null);
      if (pending?.id === request.id) {
        await this.store.setAtomic(this.responseName(request.id), {
          id: request.id,
          ok: true,
          status: response.status,
          finalUrl: response.finalUrl || localUrl,
          headers: headerEntries(response.headers),
          text: response.text,
          transport: response.transport,
          transportFallback: response.transportFallback
        });
      }
    } catch (error) {
      const pending = await this.store.get(this.requestName(this.site), null);
      if (pending?.id === request.id) {
        await this.store.setAtomic(this.responseName(request.id), {
          id: request.id,
          ok: false,
          status: error?.status || "network-error",
          message: error instanceof Error ? error.message : String(error || "跨标签页请求失败"),
          transport: error?.details?.transport,
          finalUrl: error?.details?.finalUrl,
          httpStatus: error?.details?.httpStatus,
          transportFallback: error?.details?.transportFallback
        });
      }
    } finally {
      this.processing.delete(request.id);
    }
  }

  async request(url, options = {}) {
    const site = siteFromUrl(url, this.global.location?.href);
    if (!site) throw new OJMonitorError("permission-denied", "该站点不支持跨标签页请求代理");
    allowedBridgeUrl(site, url, this.global.location?.href);
    const previous = this.chains.get(site) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.chains.set(site, tail);
    await previous;
    try {
      return await this.requestSerial(site, url, options);
    } finally {
      release();
      if (this.chains.get(site) === tail) this.chains.delete(site);
    }
  }

  async requestSerial(site, url, options) {
    const presence = await this.store.get(this.presenceName(site), null);
    if (!presence || this.clock() - Number(presence.at || 0) > this.presenceMaxAge) {
      throw new OJMonitorError(
        "source-unavailable",
        `未检测到运行新版脚本的${SITE_LABELS[site]}标签页；请打开或刷新该站点页面后重试`
      );
    }
    const id = createId("site-request");
    const requestName = this.requestName(site);
    const responseName = this.responseName(id);
    const deadline = this.clock() + (Number.isFinite(options.timeout) ? options.timeout : this.timeout);
    await this.store.setAtomic(requestName, {
      id,
      site,
      url: String(url),
      method: options.method || "GET",
      headers: headerObject(options.headers),
      createdAt: this.clock()
    });
    try {
      for (;;) {
        if (options.signal?.aborted) throw new OJMonitorError("network-error", "跨标签页请求已取消");
        const response = await this.store.get(responseName, null);
        if (response?.id === id) {
          if (!response.ok) {
            throw new OJMonitorError(response.status, response.message, {
              transport: `site-tab:${response.transport || site}`,
              finalUrl: response.finalUrl,
              httpStatus: response.httpStatus,
              transportFallback: response.transportFallback
            });
          }
          return {
            status: response.status,
            finalUrl: response.finalUrl,
            headers: new Map(response.headers || []),
            text: response.text,
            transport: `site-tab:${response.transport || site}`,
            transportFallback: response.transportFallback
          };
        }
        if (this.clock() >= deadline) {
          throw new OJMonitorError("network-error", `${SITE_LABELS[site]}标签页没有及时响应跨页面请求`);
        }
        await this.sleep(Math.min(this.pollInterval, Math.max(1, deadline - this.clock())));
      }
    } finally {
      await this.store.delete(responseName);
      const current = await this.store.get(requestName, null);
      if (current?.id === id) await this.store.delete(requestName);
    }
  }
}

module.exports = { ALLOWED_PATHS, SiteSessionBridge, allowedBridgeUrl, headerEntries, headerObject, siteFromUrl, workerSiteFromLocation };
