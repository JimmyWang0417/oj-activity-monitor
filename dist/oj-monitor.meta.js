// ==UserScript==
// @name         OJ Monitor
// @namespace    https://github.com/oj-monitor/userscript
// @version      0.2.18
// @description  在本地浏览器中按人监测多个 OJ 的近期提交与过题情况
// @author       OJ Monitor contributors
// @license      GPL-3.0-only
// @homepageURL  https://github.com/JimmyWang0417/oj-activity-monitor
// @supportURL   https://github.com/JimmyWang0417/oj-activity-monitor/issues
// @updateURL    https://raw.githubusercontent.com/JimmyWang0417/oj-activity-monitor/main/dist/oj-monitor.meta.js
// @downloadURL  https://raw.githubusercontent.com/JimmyWang0417/oj-activity-monitor/main/dist/oj-monitor.user.js
// @match        https://codeforces.com/*
// @match        https://*.codeforces.com/*
// @match        https://codeforc.es/*
// @match        https://*.codeforc.es/*
// @match        https://atcoder.jp/*
// @match        https://vjudge.net/*
// @match        https://luogu.com.cn/*
// @match        https://www.luogu.com.cn/*
// @match        https://ac.nowcoder.com/*
// @match        https://qoj.ac/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      codeforces.com
// @connect      *.codeforces.com
// @connect      codeforc.es
// @connect      *.codeforc.es
// @connect      atcoder.jp
// @connect      kenkoooo.com
// @connect      vjudge.net
// @connect      luogu.com.cn
// @connect      www.luogu.com.cn
// @connect      ac.nowcoder.com
// @connect      qoj.ac
// ==/UserScript==
