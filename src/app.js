"use strict";

const { createAdapters } = require("./adapters");
const { OJMonitorError } = require("./core");
const { HttpClient } = require("./request");
const { DomainRateLimiter, LeaseCoordinator } = require("./scheduler");
const { Diagnostics, MonitorService } = require("./service");
const { SiteSessionBridge } = require("./site-bridge");
const { GMBackend, Store } = require("./storage");
const { MonitorPanel } = require("./ui");

class OJMonitorApplication {
  constructor(globalObject = globalThis) {
    this.global = globalObject;
    this.store = new Store(new GMBackend(globalObject));
    this.limiter = new DomainRateLimiter(this.store);
    this.lease = new LeaseCoordinator(this.store);
    this.siteBridge = new SiteSessionBridge({ store: this.store, globalObject });
    this.client = new HttpClient({
      globalObject,
      siteBridge: this.siteBridge,
      onRetry: async (url) => {
        const hostname = new URL(url, globalObject.location?.href).hostname;
        const intervals = { "codeforces.com": 2000, "kenkoooo.com": 1000, "atcoder.jp": 500, "vjudge.net": 500, "www.luogu.com.cn": 500, "luogu.com.cn": 500, "qoj.ac": 750 };
        await this.limiter.waitTurn(hostname, intervals[hostname] || 500);
      }
    });
    this.siteBridge.client = this.client;
    this.diagnostics = new Diagnostics();
    this.adapters = createAdapters({ client: this.client, store: this.store, limiter: this.limiter });
    this.service = new MonitorService({ store: this.store, adapters: this.adapters, diagnostics: this.diagnostics });
    this.abortController = null;
    this.panel = null;
  }

  async start() {
    await this.siteBridge.start();
    const config = await this.store.loadConfig();
    this.panel = new MonitorPanel({
      globalObject: this.global,
      store: this.store,
      service: this.service,
      config,
      onRefresh: (onProgress) => this.refresh(onProgress),
      onCancel: () => this.cancelRefresh()
    });
    this.panel.mount();
    return this;
  }

  async refresh(onProgress) {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    const config = await this.store.loadConfig();
    const previousRefresh = await this.store.get("last-refresh", null);
    const previousRefreshAt = Number(previousRefresh?.at || 0);
    const ttl = 120000;
    try {
      for (;;) {
        if (controller.signal.aborted) throw new OJMonitorError("network-error", "获取已取消");
        const response = await this.lease.runExclusive("global-refresh", async () => {
          const value = await this.service.refresh(config, { signal: controller.signal, onProgress });
          if (controller.signal.aborted) throw new OJMonitorError("network-error", "获取已取消");
          return value;
        }, { ttl, attempts: 1 });
        if (response.acquired) return response;

        onProgress?.({ type: "lease-wait" });
        const outcome = await this.lease.waitForRelease("global-refresh", {
          signal: controller.signal,
          timeout: 30 * 60 * 1000,
          pollInterval: 1000,
          isComplete: async () => {
            const latest = await this.store.get("last-refresh", null);
            return Number(latest?.at || 0) > previousRefreshAt ? latest : false;
          }
        });
        if (outcome.reason === "completed") {
          onProgress?.({ type: "shared-complete", lastRefresh: outcome.value });
          return { acquired: false, shared: true, value: outcome.value };
        }
        if (outcome.reason === "available") {
          onProgress?.({ type: "lease-takeover" });
          continue;
        }
        throw new OJMonitorError("network-error", "等待另一个标签页获取超时，请关闭无响应的 OJ 标签页后重试");
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  cancelRefresh() {
    this.abortController?.abort();
  }
}

module.exports = { OJMonitorApplication };
