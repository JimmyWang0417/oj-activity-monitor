"use strict";

const { createId, normalizeConfig, recentDateKeys, zonedDateKey } = require("./core");
const {
  SOURCE_FILTERS,
  buildDailyRows,
  buildGroupRows,
  buildHeatmapSeries,
  filterSubmissions,
  levelLabelsFor
} = require("./view-model");

const STATUS_LABELS = Object.freeze({
  ok: "正常",
  loading: "正在加载",
  "not-found": "用户不存在",
  "login-required": "需要登录本地 OJ 账号",
  "verification-required": "需要浏览器验证",
  "permission-denied": "本地账号无查看权限",
  "rate-limited": "请求频率过高",
  "schema-changed": "页面结构可能已变化",
  "source-unavailable": "数据源暂时不可用",
  partial: "数据可能不完整",
  "network-error": "网络错误"
});

const JUDGE_LABELS = Object.freeze({ codeforces: "Codeforces", atcoder: "AtCoder", vjudge: "VJudge", luogu: "洛谷", qoj: "QOJ" });

const CSS = `
#oj-monitor-root, #oj-monitor-root * { box-sizing: border-box; }
#oj-monitor-entry { position: fixed; z-index: 2147483645; right: 16px; top: 72px; border: 0; border-radius: 999px; background: #2563eb; color: #fff; padding: 9px 14px; font: 600 13px/1.2 system-ui,sans-serif; box-shadow: 0 4px 16px #0003; cursor: pointer; }
#oj-monitor-root { --oj-bg:#fff; --oj-panel:#f6f8fa; --oj-text:#1f2328; --oj-muted:#656d76; --oj-border:#d0d7de; --oj-accent:#0969da; --oj-level0:#ebedf0; --oj-level1:#9be9a8; --oj-level2:#40c463; --oj-level3:#30a14e; --oj-level4:#216e39; position:fixed; inset:0; z-index:2147483646; background:#0008; color:var(--oj-text); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
#oj-monitor-root.oj-monitor-hidden { display:none; }
#oj-monitor-root.oj-monitor-theme-light { --oj-bg:#fff; --oj-panel:#f6f8fa; --oj-text:#1f2328; --oj-muted:#656d76; --oj-border:#d0d7de; --oj-accent:#0969da; --oj-level0:#ebedf0; --oj-level1:#9be9a8; --oj-level2:#40c463; --oj-level3:#30a14e; --oj-level4:#216e39; }
#oj-monitor-root.oj-monitor-theme-dark { --oj-bg:#0d1117; --oj-panel:#161b22; --oj-text:#e6edf3; --oj-muted:#8b949e; --oj-border:#30363d; --oj-accent:#58a6ff; --oj-level0:#161b22; --oj-level1:#0e4429; --oj-level2:#006d32; --oj-level3:#26a641; --oj-level4:#39d353; }
@media (prefers-color-scheme: dark) { #oj-monitor-root { --oj-bg:#0d1117; --oj-panel:#161b22; --oj-text:#e6edf3; --oj-muted:#8b949e; --oj-border:#30363d; --oj-accent:#58a6ff; --oj-level0:#161b22; --oj-level1:#0e4429; --oj-level2:#006d32; --oj-level3:#26a641; --oj-level4:#39d353; } }
.oj-monitor-shell { position:absolute; inset:3vh 3vw; max-width:1500px; margin:auto; display:flex; flex-direction:column; background:var(--oj-bg); border:1px solid var(--oj-border); border-radius:12px; box-shadow:0 20px 70px #0008; overflow:hidden; }
.oj-monitor-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--oj-border); background:var(--oj-panel); }
.oj-monitor-title { margin:0 auto 0 0; font-size:18px; }
.oj-monitor-control-label { display:inline-flex; align-items:center; gap:5px; color:var(--oj-muted); white-space:nowrap; }
.oj-monitor-body { overflow:auto; padding:16px; flex:1; }
.oj-monitor-section { margin:0 0 16px; padding:14px; border:1px solid var(--oj-border); border-radius:8px; background:var(--oj-bg); }
.oj-monitor-section h2,.oj-monitor-section h3 { margin:0 0 10px; font-size:15px; }
.oj-monitor-control,.oj-monitor-button,.oj-monitor-input,.oj-monitor-select { min-height:32px; border:1px solid var(--oj-border); border-radius:6px; color:var(--oj-text); background:var(--oj-bg); padding:5px 9px; font:inherit; }
.oj-monitor-button { cursor:pointer; }
.oj-monitor-button-primary { border-color:var(--oj-accent); background:var(--oj-accent); color:#fff; }
.oj-monitor-button-danger { color:#cf222e; }
.oj-monitor-muted { color:var(--oj-muted); }
.oj-monitor-banner { margin:0 0 12px; padding:9px 11px; border-radius:6px; background:var(--oj-panel); white-space:pre-wrap; }
.oj-monitor-banner[data-status="partial"],.oj-monitor-banner[data-status="verification-required"],.oj-monitor-banner[data-status="login-required"] { border-left:4px solid #bf8700; }
.oj-monitor-heatmap-row { display:flex; align-items:flex-start; gap:12px; margin:10px 0; overflow:auto; }
.oj-monitor-heatmap-label { width:120px; flex:0 0 120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-top:2px; font-weight:600; }
.oj-monitor-heatmap { display:grid; grid-template-rows:repeat(7,12px); grid-auto-flow:column; grid-auto-columns:12px; gap:3px; }
.oj-monitor-day { width:12px; height:12px; padding:0; border:0; border-radius:2px; background:var(--oj-level0); cursor:pointer; }
.oj-monitor-day[data-level="1"] { background:var(--oj-level1); }.oj-monitor-day[data-level="2"] { background:var(--oj-level2); }.oj-monitor-day[data-level="3"] { background:var(--oj-level3); }.oj-monitor-day[data-level="4"] { background:var(--oj-level4); }
.oj-monitor-day[data-partial="true"] { outline:1px dashed #bf8700; outline-offset:1px; }
.oj-monitor-day-pad { visibility:hidden; }
.oj-monitor-legend { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:8px; color:var(--oj-muted); font-size:12px; }.oj-monitor-legend-item { display:inline-flex; align-items:center; gap:3px; }.oj-monitor-legend-item i { width:12px; height:12px; border-radius:2px; background:var(--oj-level0); }.oj-monitor-legend-item[data-level="1"] i{background:var(--oj-level1)}.oj-monitor-legend-item[data-level="2"] i{background:var(--oj-level2)}.oj-monitor-legend-item[data-level="3"] i{background:var(--oj-level3)}.oj-monitor-legend-item[data-level="4"] i{background:var(--oj-level4)}
.oj-monitor-table-wrap { overflow:auto; }.oj-monitor-table { border-collapse:collapse; width:100%; min-width:760px; }.oj-monitor-table th,.oj-monitor-table td { border-bottom:1px solid var(--oj-border); padding:7px 8px; text-align:left; white-space:nowrap; }.oj-monitor-table th { position:sticky; top:0; background:var(--oj-panel); }
.oj-monitor-section-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }.oj-monitor-section-head h2 { margin:0 auto 0 0; }
.oj-monitor-status { display:inline-block; border-radius:999px; padding:2px 7px; background:var(--oj-panel); font-size:12px; }.oj-monitor-status[data-status="ok"] { color:#1a7f37; }.oj-monitor-status:not([data-status="ok"]){color:#9a6700;}
.oj-monitor-settings { position:absolute; inset:7% 8%; overflow:auto; padding:16px; background:var(--oj-bg); border:1px solid var(--oj-border); border-radius:10px; box-shadow:0 10px 50px #0008; }
.oj-monitor-settings-head,.oj-monitor-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }.oj-monitor-settings-head { margin-bottom:14px; }.oj-monitor-settings-head h2 { margin:0 auto 0 0; }
.oj-monitor-group-editor { border:1px solid var(--oj-border); border-radius:8px; margin:10px 0; padding:10px; }.oj-monitor-account { margin:8px 0 0 20px; padding:8px; background:var(--oj-panel); border-radius:6px; }
.oj-monitor-details-list { list-style:none; padding:0; margin:0; }.oj-monitor-details-list li { display:grid; grid-template-columns:150px 100px 1fr 150px; gap:8px; padding:6px 0; border-bottom:1px solid var(--oj-border); }.oj-monitor-details-list a { color:var(--oj-accent); }
@media (max-width:700px) { .oj-monitor-shell { inset:0; border-radius:0; }.oj-monitor-header { align-items:stretch; }.oj-monitor-title { width:100%; }.oj-monitor-settings { inset:2%; }.oj-monitor-details-list li { grid-template-columns:1fr; }.oj-monitor-heatmap-label { width:80px; flex-basis:80px; } }
`;

function element(documentObject, tag, attributes = {}, children = []) {
  const node = documentObject.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(name, "");
    else if (value !== false && value !== undefined && value !== null) node.setAttribute(name, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : documentObject.createTextNode(String(child)));
  }
  return node;
}

function option(documentObject, value, label, selected = false) {
  return element(documentObject, "option", { value, text: label, selected });
}

function statusBadge(documentObject, status, suffix = "") {
  return element(documentObject, "span", { class: "oj-monitor-status", "data-status": status, text: `${STATUS_LABELS[status] || status}${suffix}` });
}

function verdictText(item) {
  const verdict = String(item?.verdict || "UNKNOWN").trim();
  if (!item?.accepted || /[✓✔√]\s*$/.test(verdict)) return verdict;
  return `${verdict} ✓`;
}

function cellText(cell) {
  const prefix = cell.coverageComplete ? "" : "≥";
  return `${prefix}${cell.solvedCount}/${prefix}${cell.submissionCount}`;
}

function displayCoverageStatus(cell) {
  return cell.coverageComplete ? cell.status : cell.status && cell.status !== "ok" ? cell.status : "partial";
}

function sourceIssueText(event) {
  const result = event?.result;
  if (!result || result.status === "ok" && result.coverage?.complete !== false) return null;
  const source = `${event.group?.name || "未知分组"} / ${JUDGE_LABELS[event.account?.judge] || event.account?.judge || "未知来源"}`;
  const status = STATUS_LABELS[result.status] || result.status || "数据不完整";
  const reason = result.warning || result.coverage?.reason;
  return `${source}：${status}${reason ? ` — ${reason}` : ""}`;
}

function sharedRefreshNotice(lastRefresh) {
  const incompleteCount = Number(lastRefresh?.incompleteCount || 0);
  return incompleteCount > 0
    ? { text: `已读取另一个标签页完成的共享结果；有 ${incompleteCount} 个来源未完整覆盖，请查看每日表格状态。`, status: "partial" }
    : { text: "已读取另一个标签页完成的共享结果。", status: "ok" };
}

class MonitorPanel {
  constructor(options) {
    this.global = options.globalObject || globalThis;
    this.document = this.global.document;
    this.store = options.store;
    this.service = options.service;
    this.onRefresh = options.onRefresh;
    this.onCancel = options.onCancel;
    this.config = normalizeConfig(options.config);
    this.data = { stats: [], submissions: [], lastRefresh: null, bounds: { dateKeys: recentDateKeys(this.config.settings.days, Date.now(), this.config.settings.timeZone) } };
    this.selectedGroup = this.config.groups[0]?.id || "all";
    this.source = "all";
    this.metric = this.config.settings.metric;
    this.dailyTableExpanded = true;
    this.refreshIssues = [];
    this.refreshing = false;
    this.autoRefreshed = false;
  }

  mount() {
    if (typeof this.global.GM_addStyle === "function") this.global.GM_addStyle(CSS);
    else this.document.head.append(element(this.document, "style", { text: CSS }));
    this.entry = element(this.document, "button", { id: "oj-monitor-entry", type: "button", text: "OJ 监测", onclick: () => this.open() });
    this.root = element(this.document, "div", { id: "oj-monitor-root", class: "oj-monitor-hidden" });
    this.document.body.append(this.entry, this.root);
    if (typeof this.global.GM_registerMenuCommand === "function") this.global.GM_registerMenuCommand("打开 OJ 监测面板", () => this.open());
    this.listenerId = this.store.watch("config", (next, _old, remote, error) => {
      if (!error && remote && next) {
        this.config = normalizeConfig(next);
        this.ensureSelection();
        if (!this.root.classList.contains("oj-monitor-hidden")) this.loadAndRender();
      }
    });
    this.dataListenerId = this.store.watch("last-refresh", (next, _old, remote, error) => {
      if (!error && remote && !this.root.classList.contains("oj-monitor-hidden")) {
        this.loadAndRender().then(() => {
          if (this.noticeStatus === "loading" && /另一个标签页/.test(this.notice || "")) {
            const shared = sharedRefreshNotice(next);
            this.notice = shared.text;
            this.noticeStatus = shared.status;
            this.render();
          }
        });
      }
    });
  }

  ensureSelection() {
    if (this.selectedGroup !== "all" && !this.config.groups.some((group) => group.id === this.selectedGroup)) {
      this.selectedGroup = this.config.groups[0]?.id || "all";
    }
  }

  async open() {
    this.root.classList.remove("oj-monitor-hidden");
    await this.loadAndRender();
    const staleAfter = this.config.settings.autoRefreshMinutes * 60 * 1000;
    if (!this.autoRefreshed && this.config.groups.length && (!this.data.lastRefresh || Date.now() - this.data.lastRefresh.at > staleAfter)) {
      this.autoRefreshed = true;
      await this.refresh();
    }
  }

  close() {
    this.root.classList.add("oj-monitor-hidden");
  }

  async loadAndRender() {
    this.data = await this.service.loadDashboard(this.config);
    this.render();
  }

  async saveConfig(config) {
    this.config = await this.store.saveConfig(config);
    this.ensureSelection();
    await this.loadAndRender();
  }

  render() {
    this.root.classList.toggle("oj-monitor-theme-light", this.config.settings.theme === "light");
    this.root.classList.toggle("oj-monitor-theme-dark", this.config.settings.theme === "dark");
    this.root.replaceChildren();
    const shell = element(this.document, "div", { class: "oj-monitor-shell" });
    shell.append(this.renderHeader(), this.renderBody());
    this.root.append(shell);
  }

  renderHeader() {
    const groupSelect = element(this.document, "select", { class: "oj-monitor-select", title: "选择监测对象", onchange: (event) => { this.selectedGroup = event.target.value; this.render(); } }, [
      option(this.document, "all", "全部分组（比较）", this.selectedGroup === "all"),
      ...this.config.groups.map((group) => option(this.document, group.id, group.name, group.id === this.selectedGroup))
    ]);
    const sourceSelect = element(this.document, "select", { class: "oj-monitor-select", title: "数据来源", onchange: (event) => { this.source = event.target.value; this.render(); } },
      SOURCE_FILTERS.map((item) => option(this.document, item.id, item.label, item.id === this.source))
    );
    const metricSelect = element(this.document, "select", { class: "oj-monitor-select", title: "热力图指标", onchange: async (event) => {
      this.metric = event.target.value;
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, metric: this.metric } });
    } }, [option(this.document, "solved", "通过题数", this.metric === "solved"), option(this.document, "submissions", "提交次数", this.metric === "submissions")]);
    const daysSelect = element(this.document, "select", { class: "oj-monitor-select", title: "时间窗口", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, days: Number(event.target.value) } });
    } }, [7, 14, 30, 60, 90].map((days) => option(this.document, days, `近 ${days} 天`, days === this.config.settings.days)));
    const timezoneSelect = element(this.document, "select", { class: "oj-monitor-select", title: "自然日时区", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, timeZone: event.target.value } });
    } }, [option(this.document, "local", "本地时区", this.config.settings.timeZone === "local"), option(this.document, "Asia/Shanghai", "北京时间", this.config.settings.timeZone === "Asia/Shanghai")]);
    return element(this.document, "header", { class: "oj-monitor-header" }, [
      element(this.document, "h1", { class: "oj-monitor-title", text: "OJ Monitor" }),
      groupSelect, sourceSelect,
      element(this.document, "label", { class: "oj-monitor-control-label" }, ["热力图指标：", metricSelect]),
      daysSelect, timezoneSelect,
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", type: "button", text: this.refreshing ? "取消获取" : "重新获取", onclick: () => this.refreshing ? this.cancelRefresh() : this.refresh() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "管理分组", onclick: () => this.renderSettings() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "诊断", onclick: () => this.showDiagnostics() }),
      element(this.document, "button", { class: "oj-monitor-button", type: "button", text: "关闭", onclick: () => this.close() })
    ]);
  }

  renderBody() {
    const body = element(this.document, "main", { class: "oj-monitor-body" });
    if (this.notice) body.append(element(this.document, "div", { class: "oj-monitor-banner", "data-status": this.noticeStatus || "ok", text: this.notice }));
    if (!this.config.groups.length) {
      body.append(element(this.document, "section", { class: "oj-monitor-section" }, [
        element(this.document, "h2", { text: "还没有监测对象" }),
        element(this.document, "p", { class: "oj-monitor-muted", text: "先创建一个以人名命名的分组，再为其添加各 OJ 用户名。" }),
        element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "创建第一个分组", onclick: () => this.renderSettings(true) })
      ]));
      return body;
    }
    if (!this.data.lastRefresh) body.append(element(this.document, "div", { class: "oj-monitor-banner", text: "尚未获取数据；打开面板后会自动获取一次，也可点击“重新获取”。" }));
    body.append(this.renderHeatmap(), this.renderTable());
    if (this.detailDate && this.selectedGroup !== "all") body.append(this.renderDetails());
    return body;
  }

  visibleGroups() {
    return this.selectedGroup === "all" ? this.config.groups : this.config.groups.filter((group) => group.id === this.selectedGroup);
  }

  renderHeatmap() {
    const groups = this.visibleGroups();
    const series = buildHeatmapSeries(this.data.stats, groups, this.data.bounds.dateKeys, { metric: this.metric, source: this.source });
    const section = element(this.document, "section", { class: "oj-monitor-section" }, [element(this.document, "h2", { text: `${SOURCE_FILTERS.find((item) => item.id === this.source)?.label || "全部网站"} · ${this.metric === "solved" ? "每日过题" : "每日提交"}` })]);
    for (const row of series) {
      const grid = element(this.document, "div", { class: "oj-monitor-heatmap", role: "grid", "aria-label": `${row.name} 热力图` });
      const offset = new Date(`${row.days[0].date}T00:00:00Z`).getUTCDay();
      for (let index = 0; index < offset; index += 1) grid.append(element(this.document, "i", { class: "oj-monitor-day oj-monitor-day-pad" }));
      for (const day of row.days) {
        const title = `${day.date}：${day.solvedCount} 题 / ${day.submissionCount} 次提交${day.coverageComplete ? "" : "（数据至少为此值）"}${day.excludedCount ? `；${day.excludedCount} 条未支持记录` : ""}`;
        grid.append(element(this.document, "button", {
          class: "oj-monitor-day", type: "button", "data-level": day.level, "data-partial": !day.coverageComplete,
          title, "aria-label": title,
          onclick: () => { this.selectedGroup = row.groupId; this.detailDate = day.date; this.render(); }
        }));
      }
      section.append(element(this.document, "div", { class: "oj-monitor-heatmap-row" }, [element(this.document, "div", { class: "oj-monitor-heatmap-label", text: row.name, title: row.name }), grid]));
    }
    section.append(element(this.document, "div", { class: "oj-monitor-legend", "aria-label": "热力图颜色档位" }, [
      element(this.document, "span", { text: this.metric === "solved" ? "通过题数：" : "提交次数：" }),
      ...levelLabelsFor(this.metric).map((label, level) => element(this.document, "span", { class: "oj-monitor-legend-item", "data-level": level }, [element(this.document, "i"), label]))
    ]));
    return section;
  }

  renderTable() {
    const section = element(this.document, "section", { class: "oj-monitor-section" });
    const sourceLabel = SOURCE_FILTERS.find((item) => item.id === this.source)?.label || "全部网站";
    const title = element(this.document, "h2", {
      text: this.selectedGroup === "all" ? `分组比较 · ${sourceLabel}` : "逐日统计（过题/提交）"
    });
    if (this.selectedGroup === "all") section.append(title);
    else {
      section.append(element(this.document, "div", { class: "oj-monitor-section-head" }, [
        title,
        element(this.document, "button", {
          class: "oj-monitor-button", type: "button",
          text: this.dailyTableExpanded ? "收起逐日统计" : "展开逐日统计",
          "aria-expanded": this.dailyTableExpanded,
          onclick: () => { this.dailyTableExpanded = !this.dailyTableExpanded; this.render(); }
        })
      ]));
      if (!this.dailyTableExpanded) return section;
    }
    const table = element(this.document, "table", { class: "oj-monitor-table" });
    if (this.selectedGroup === "all") {
      table.append(element(this.document, "thead", {}, element(this.document, "tr", {}, ["分组", "过题数", "提交数", "排除记录", "数据状态"].map((text) => element(this.document, "th", { text })) )));
      const tbody = element(this.document, "tbody");
      for (const row of buildGroupRows(this.data.stats, this.config.groups, this.data.bounds.dateKeys, this.source)) {
        tbody.append(element(this.document, "tr", {}, [
          element(this.document, "td", { text: row.name }), element(this.document, "td", { text: row.coverageComplete ? row.solvedCount : `≥${row.solvedCount}` }),
          element(this.document, "td", { text: row.coverageComplete ? row.submissionCount : `≥${row.submissionCount}` }), element(this.document, "td", { text: row.excludedCount }),
          element(this.document, "td", {}, statusBadge(this.document, displayCoverageStatus(row)))
        ]));
      }
      table.append(tbody);
    } else {
      const group = this.config.groups.find((item) => item.id === this.selectedGroup);
      const hasSource = (judge, scope) => group?.accounts.some((account) => account.enabled && account.judge === judge && (judge !== "codeforces" || account.scopes?.[scope] !== false));
      table.append(element(this.document, "thead", {}, element(this.document, "tr", {}, ["日期", "CF Problemset", "CF Gym", "AtCoder", "VJudge", "洛谷", "QOJ", "合计", "状态"].map((text) => element(this.document, "th", { text })) )));
      const tbody = element(this.document, "tbody");
      for (const row of buildDailyRows(this.data.stats, this.selectedGroup, this.data.bounds.dateKeys)) {
        const sourceCells = [
          [row.problemset, hasSource("codeforces", "problemset")], [row.gym, hasSource("codeforces", "gym")],
          [row.atcoder, hasSource("atcoder")], [row.vjudge, hasSource("vjudge")], [row.luogu, hasSource("luogu")], [row.qoj, hasSource("qoj")]
        ];
        tbody.append(element(this.document, "tr", { onclick: () => { this.detailDate = row.date; this.render(); } }, [
          element(this.document, "td", { text: row.date }), ...sourceCells.map(([cell, exists]) => element(this.document, "td", { text: exists ? cellText(cell) : "—" })), element(this.document, "td", { text: cellText(row.total) }),
          element(this.document, "td", {}, statusBadge(this.document, displayCoverageStatus(row.total)))
        ]));
      }
      table.append(tbody);
    }
    section.append(element(this.document, "div", { class: "oj-monitor-table-wrap" }, table));
    return section;
  }

  renderDetails() {
    const group = this.config.groups.find((item) => item.id === this.selectedGroup);
    const submissions = filterSubmissions(this.data.submissions, this.selectedGroup, this.detailDate, this.config.settings.timeZone, this.source, zonedDateKey);
    const list = element(this.document, "ul", { class: "oj-monitor-details-list" });
    for (const item of submissions) {
      const link = element(this.document, "a", { href: item.problemUrl || "#", target: "_blank", rel: "noopener noreferrer", text: item.problemName || item.problemKey });
      list.append(element(this.document, "li", {}, [
        element(this.document, "time", { text: new Date(item.submittedAt).toLocaleString() }),
        element(this.document, "span", { text: `${JUDGE_LABELS[item.judge]}${item.scope === "default" ? "" : ` / ${item.scope}`}` }),
        link,
        element(this.document, "span", { text: verdictText(item) })
      ]));
    }
    return element(this.document, "section", { class: "oj-monitor-section" }, [
      element(this.document, "h2", { text: `${group?.name || ""} · ${this.detailDate} 提交明细` }),
      submissions.length ? list : element(this.document, "p", { class: "oj-monitor-muted", text: "当前筛选下没有已取得的提交。" })
    ]);
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshIssues = [];
    this.notice = "正在获取各 OJ 数据…";
    this.noticeStatus = "loading";
    this.render();
    try {
      const response = await this.onRefresh((event) => {
        if (event.type === "lease-wait") {
          this.notice = "另一个标签页正在获取数据；本页会等待共享结果，并在租约失效后自动接管。";
          this.noticeStatus = "loading";
          this.render();
        } else if (event.type === "lease-takeover") {
          this.notice = "原获取标签页已退出或租约过期，本页正在自动接管…";
          this.noticeStatus = "loading";
          this.render();
        } else if (event.type === "source-complete") {
          const issue = sourceIssueText(event);
          if (issue) this.refreshIssues.push(issue);
          this.notice = issue || `${event.group.name} / ${JUDGE_LABELS[event.account.judge]}：正常`;
          this.noticeStatus = event.result.status;
          this.render();
        } else if (event.type === "source-crash") {
          const issue = sourceIssueText({
            ...event,
            result: { status: event.error?.status || "network-error", coverage: { complete: false }, warning: event.error?.message }
          });
          if (issue) this.refreshIssues.push(issue);
          this.notice = issue;
          this.noticeStatus = event.error?.status || "network-error";
          this.render();
        }
      });
      if (response?.acquired === false && response?.shared === true) {
        const shared = sharedRefreshNotice(response.value);
        this.notice = shared.text;
        this.noticeStatus = shared.status;
      } else if (response?.acquired === false) {
        this.notice = "未能取得刷新租约，请关闭无响应的 OJ 标签页后重试。";
        this.noticeStatus = "network-error";
      } else {
        this.notice = this.refreshIssues.length
          ? `获取完成，但有 ${this.refreshIssues.length} 个来源未完整覆盖：\n${this.refreshIssues.join("\n")}`
          : `获取完成：${new Date().toLocaleString()}`;
        this.noticeStatus = this.refreshIssues.length ? "partial" : "ok";
      }
      await this.loadAndRender();
    } catch (error) {
      this.notice = `获取失败：${error.message}`;
      this.noticeStatus = error.status || "network-error";
      await this.loadAndRender();
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  cancelRefresh() {
    this.onCancel?.();
    this.notice = "正在取消请求…";
    this.noticeStatus = "loading";
    this.render();
  }

  renderSettings(createInitial = false) {
    this.render();
    const overlay = element(this.document, "section", { class: "oj-monitor-settings" });
    overlay.append(element(this.document, "div", { class: "oj-monitor-settings-head" }, [
      element(this.document, "h2", { text: "管理监测分组" }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "新建分组", onclick: async () => {
        const name = this.global.prompt?.("分组名称（通常填写被监测者姓名）", "新监测对象");
        if (!name?.trim()) return;
        const now = Date.now();
        const group = { id: createId("group"), name: name.trim(), accounts: [], sortOrder: this.config.groups.length, createdAt: now, updatedAt: now };
        this.selectedGroup = group.id;
        await this.saveConfig({ ...this.config, groups: [...this.config.groups, group] });
        this.renderSettings();
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "返回面板", onclick: () => this.render() })
    ]));
    const theme = element(this.document, "select", { class: "oj-monitor-select", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, theme: event.target.value } });
      this.renderSettings();
    } }, ["system", "light", "dark"].map((value) => option(this.document, value, { system: "跟随系统", light: "浅色", dark: "深色" }[value], this.config.settings.theme === value)));
    const refreshInterval = element(this.document, "select", { class: "oj-monitor-select", onchange: async (event) => {
      await this.saveConfig({ ...this.config, settings: { ...this.config.settings, autoRefreshMinutes: Number(event.target.value) } });
      this.renderSettings();
    } }, [15, 30, 60].map((value) => option(this.document, value, `${value} 分钟自动刷新间隔`, this.config.settings.autoRefreshMinutes === value)));
    overlay.append(element(this.document, "div", { class: "oj-monitor-row" }, [element(this.document, "span", { text: "外观：" }), theme, element(this.document, "span", { text: "打开面板时的缓存有效期：" }), refreshInterval]));
    for (const [groupIndex, group] of this.config.groups.entries()) overlay.append(this.renderGroupEditor(group, groupIndex));
    this.root.querySelector(".oj-monitor-shell").append(overlay);
    if (createInitial && !this.config.groups.length) overlay.querySelector("button")?.focus();
  }

  renderGroupEditor(group, groupIndex) {
    const nameInput = element(this.document, "input", { class: "oj-monitor-input", value: group.name, "aria-label": "分组名称" });
    const container = element(this.document, "article", { class: "oj-monitor-group-editor" });
    const updateGroups = async (groups) => { await this.saveConfig({ ...this.config, groups }); this.renderSettings(); };
    container.append(element(this.document, "div", { class: "oj-monitor-row" }, [
      nameInput,
      element(this.document, "button", { class: "oj-monitor-button", text: "保存名称", onclick: async () => {
        if (!nameInput.value.trim()) return;
        await updateGroups(this.config.groups.map((item) => item.id === group.id ? { ...item, name: nameInput.value.trim(), updatedAt: Date.now() } : item));
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "上移", disabled: groupIndex === 0, onclick: async () => {
        const groups = [...this.config.groups]; [groups[groupIndex - 1], groups[groupIndex]] = [groups[groupIndex], groups[groupIndex - 1]];
        await updateGroups(groups.map((item, index) => ({ ...item, sortOrder: index })));
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "下移", disabled: groupIndex === this.config.groups.length - 1, onclick: async () => {
        const groups = [...this.config.groups]; [groups[groupIndex], groups[groupIndex + 1]] = [groups[groupIndex + 1], groups[groupIndex]];
        await updateGroups(groups.map((item, index) => ({ ...item, sortOrder: index })));
      } }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-danger", text: "删除分组", onclick: async () => {
        if (this.global.confirm?.(`删除分组“${group.name}”及其本地缓存？`)) {
          for (const account of group.accounts) await this.store.removeAccount(account.id);
          await updateGroups(this.config.groups.filter((item) => item.id !== group.id));
        }
      } })
    ]));
    for (const account of group.accounts) container.append(this.renderAccountEditor(group, account));
    container.append(this.renderAddAccount(group));
    return container;
  }

  renderAccountEditor(group, account) {
    const username = element(this.document, "input", { class: "oj-monitor-input", value: account.username, "aria-label": `${JUDGE_LABELS[account.judge]} 用户名` });
    const enabled = element(this.document, "input", { type: "checkbox", checked: account.enabled });
    const problemset = element(this.document, "input", { type: "checkbox", checked: account.scopes?.problemset !== false });
    const gym = element(this.document, "input", { type: "checkbox", checked: account.scopes?.gym !== false });
    const row = element(this.document, "div", { class: "oj-monitor-account oj-monitor-row" }, [
      element(this.document, "strong", { text: JUDGE_LABELS[account.judge] }), username,
      element(this.document, "label", {}, [enabled, " 启用"])
    ]);
    if (account.judge === "codeforces") row.append(element(this.document, "label", {}, [problemset, " Problemset"]), element(this.document, "label", {}, [gym, " Gym"]));
    row.append(
      element(this.document, "button", { class: "oj-monitor-button", text: "保存", onclick: async () => {
        const updated = { ...account, username: username.value.trim(), enabled: enabled.checked };
        if (account.judge === "codeforces") updated.scopes = { problemset: problemset.checked, gym: gym.checked };
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: item.accounts.map((entry) => entry.id === account.id ? updated : entry), updatedAt: Date.now() } : item);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } }),
      element(this.document, "button", { class: "oj-monitor-button", text: "测试用户", onclick: async (event) => {
        event.target.disabled = true; event.target.textContent = "测试中…";
        const result = await this.service.validateAccount({ ...account, username: username.value.trim() });
        event.target.disabled = false; event.target.textContent = STATUS_LABELS[result.status] || result.status;
      } }),
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-danger", text: "删除", onclick: async () => {
        if (!this.global.confirm?.(`删除 ${JUDGE_LABELS[account.judge]} 账号 ${account.username}？`)) return;
        await this.store.removeAccount(account.id);
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: item.accounts.filter((entry) => entry.id !== account.id) } : item);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } })
    );
    return row;
  }

  renderAddAccount(group) {
    const judge = element(this.document, "select", { class: "oj-monitor-select" }, Object.entries(JUDGE_LABELS).map(([id, label]) => option(this.document, id, label)));
    const username = element(this.document, "input", { class: "oj-monitor-input", placeholder: "用户名或 UID" });
    return element(this.document, "div", { class: "oj-monitor-account oj-monitor-row" }, [
      judge, username,
      element(this.document, "button", { class: "oj-monitor-button oj-monitor-button-primary", text: "添加网站账号", onclick: async () => {
        if (!username.value.trim()) return;
        const account = { id: createId("account"), judge: judge.value, username: username.value.trim(), enabled: true, sortOrder: group.accounts.length };
        if (judge.value === "codeforces") account.scopes = { problemset: true, gym: true };
        const groups = this.config.groups.map((item) => item.id === group.id ? { ...item, accounts: [...item.accounts, account], updatedAt: Date.now() } : item);
        await this.saveConfig({ ...this.config, groups }); this.renderSettings();
      } })
    ]);
  }

  showDiagnostics() {
    const text = this.service.diagnostics.export();
    const modal = element(this.document, "section", { class: "oj-monitor-settings" }, [
      element(this.document, "div", { class: "oj-monitor-settings-head" }, [
        element(this.document, "h2", { text: "脱敏诊断日志" }),
        element(this.document, "button", { class: "oj-monitor-button", text: "复制", onclick: async () => { await this.global.navigator?.clipboard?.writeText(text); } }),
        element(this.document, "button", { class: "oj-monitor-button", text: "关闭", onclick: () => modal.remove() })
      ]),
      element(this.document, "pre", { text })
    ]);
    this.root.querySelector(".oj-monitor-shell").append(modal);
  }
}

module.exports = { CSS, JUDGE_LABELS, MonitorPanel, STATUS_LABELS, cellText, displayCoverageStatus, element, sharedRefreshNotice, sourceIssueText, verdictText };
