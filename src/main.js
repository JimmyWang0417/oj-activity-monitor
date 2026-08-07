"use strict";

const core = require("./core");
const adapters = require("./adapters");
const app = require("./app");
const request = require("./request");
const scheduler = require("./scheduler");
const service = require("./service");
const siteBridge = require("./site-bridge");
const storage = require("./storage");
const ui = require("./ui");
const viewModel = require("./view-model");

const api = Object.freeze({
    version: "0.2.11",
  ...adapters,
  ...app,
  ...core,
  ...request,
  ...scheduler,
  ...service,
  ...siteBridge,
  ...storage,
  ...ui,
  ...viewModel
});

if (typeof document !== "undefined" && !globalThis.__OJMON_TEST__) {
  const start = async () => {
    try {
      const application = await new app.OJMonitorApplication(globalThis).start();
      globalThis.__OJ_MONITOR_APP__ = application;
      if (globalThis.__OJMON_SMOKE_OPEN__) await application.panel.open();
    } catch (error) {
      console.error("[OJ Monitor] 初始化失败", error);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

module.exports = api;
