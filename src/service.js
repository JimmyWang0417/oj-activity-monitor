"use strict";

const { aggregateDaily, mergeSubmissions, recentDateKeys } = require("./core");
const { failureResult, newestResumeBoundary } = require("./adapters/common");

const FULL_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function sourceIdentity(result) {
  return [result.groupId, result.accountId, result.judge, result.scope].join(":");
}

function firstDateEpoch(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (timeZone === "Asia/Shanghai") return Date.parse(`${dateKey}T00:00:00+08:00`);
  return new Date(year, month - 1, day).getTime();
}

function windowBounds(settings, now = Date.now()) {
  const dateKeys = recentDateKeys(settings.days, now, settings.timeZone);
  return { dateKeys, from: firstDateEpoch(dateKeys[0], settings.timeZone), to: now };
}

function sourceResumeBoundary(state) {
  return state?.diagnostics?.resumeBoundary || null;
}

function trustedSourceState(state) {
  if (state?.trusted?.coverage?.complete === true) return state.trusted;
  return state?.coverage?.complete === true ? state : null;
}

class Diagnostics {
  constructor(limit = 200) {
    this.limit = limit;
    this.entries = [];
  }

  add(entry) {
    this.entries.push({ at: Date.now(), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  export() {
    return JSON.stringify({ generatedAt: Date.now(), entries: this.entries }, null, 2);
  }
}

class MonitorService {
  constructor(options) {
    this.store = options.store;
    this.adapters = options.adapters;
    this.diagnostics = options.diagnostics || new Diagnostics();
    this.clock = options.clock || (() => Date.now());
  }

  async validateAccount(account, signal) {
    const adapter = this.adapters[account.judge];
    if (!adapter) return { exists: null, status: "source-unavailable", message: "未知 OJ" };
    return adapter.validateUser(account.username, { signal });
  }

  async fetchAccount(group, account, bounds, signal, onProgress) {
    const selectedScopes = account.judge === "codeforces"
      ? ["problemset", "gym"].filter((scope) => account.scopes?.[scope] !== false)
      : ["default"];
    const previousStates = await Promise.all(selectedScopes.map((scope) =>
      this.store.loadSourceState([group.id, account.id, account.judge, scope].join(":"))
    ));
    const previousTrustedStates = previousStates.map(trustedSourceState);
    const previousTrustedByScope = Object.fromEntries(selectedScopes.map((scope, index) => [scope, previousTrustedStates[index]]));
    const canIncrement = previousTrustedStates.length > 0 && previousTrustedStates.every((state) =>
      state?.coverage?.complete === true && state.coverage.from <= bounds.from && Number.isFinite(state.coverage.to)
    );
    const previousTo = canIncrement ? Math.min(...previousTrustedStates.map((state) => state.coverage.to)) : bounds.from;
    const previousFullScanAt = canIncrement && previousTrustedStates.every((state) => Number.isFinite(state?.diagnostics?.fullScanAt))
      ? Math.min(...previousTrustedStates.map((state) => state.diagnostics.fullScanAt))
      : null;
    const fullScanDue = !Number.isFinite(previousFullScanAt) || bounds.to - previousFullScanAt >= FULL_REFRESH_INTERVAL_MS;
    const queryFrom = canIncrement && !fullScanDue ? Math.max(bounds.from, previousTo - 86400000) : bounds.from;
    const effectiveQueryFrom = account.judge === "vjudge" ? bounds.from : queryFrom;
    const base = {
      groupId: group.id,
      accountId: account.id,
      username: account.username,
      from: effectiveQueryFrom,
      to: bounds.to,
      signal
    };
    const resumeBoundaries = Object.fromEntries(selectedScopes.map((scope, index) => [
      scope, canIncrement && !fullScanDue && !["atcoder", "vjudge"].includes(account.judge) ? sourceResumeBoundary(previousTrustedStates[index]) : null
    ]).filter(([_scope, boundary]) => boundary));
    if (account.judge === "codeforces" && selectedScopes.every((scope) => resumeBoundaries[scope])) base.resumeBoundaries = resumeBoundaries;
    else base.resumeBoundary = resumeBoundaries.default || null;
    const adapter = this.adapters[account.judge];
    onProgress?.({ type: "source-start", group, account });
    const startedAt = this.clock();
    let results;
    if (account.judge === "codeforces") {
      const both = await adapter.fetchBoth(base);
      results = [];
      if (account.scopes?.problemset !== false) results.push(both.problemset);
      if (account.scopes?.gym !== false) {
        let gym = both.gym;
        if (gym.status === "ok" && adapter.canUseVisibleGymSupplement?.()) {
          const contestKinds = await adapter.getContestKinds(signal);
          const supplement = await adapter.fetchVisibleGymSupplement({ ...base, scope: "gym" }, contestKinds);
          if (supplement.submissions.length) {
            gym = {
              ...gym,
              status: "partial",
              submissions: mergeSubmissions(gym.submissions, supplement.submissions),
              warning: supplement.warning,
              coverage: { ...gym.coverage, complete: false, reason: supplement.coverage.reason },
              diagnostics: { ...gym.diagnostics, supplement: supplement.diagnostics }
            };
          }
        }
        results.push(gym);
      }
    } else {
      results = [await adapter.fetchSubmissions({ ...base, scope: "default" })];
    }
    for (const result of results) {
      if (canIncrement && result.coverage.complete) {
        result.coverage.from = bounds.from;
        result.diagnostics = {
          ...result.diagnostics,
          ...(fullScanDue ? { fullRefreshFrom: queryFrom } : { incrementalFrom: queryFrom })
        };
      }
      if (result.coverage.complete) {
        const previousBoundary = ["atcoder", "vjudge"].includes(result.judge)
          ? null
          : sourceResumeBoundary(previousTrustedByScope[result.scope]);
        const boundary = result.judge === "vjudge" ? null : newestResumeBoundary(result.submissions) || previousBoundary;
        const priorFullScanAt = previousTrustedByScope[result.scope]?.diagnostics?.fullScanAt;
        result.diagnostics = {
          ...result.diagnostics,
          ...(boundary ? { resumeBoundary: boundary } : { resumeBoundary: undefined }),
          fullScanAt: fullScanDue ? bounds.to : priorFullScanAt
        };
      }
      this.diagnostics.add({
        judge: result.judge,
        scope: result.scope,
        groupId: group.id,
        accountId: account.id,
        durationMs: this.clock() - startedAt,
        status: result.status,
        recordCount: result.submissions.length,
        stopReason: result.diagnostics?.stopReason,
        pageOrigin: result.diagnostics?.pageOrigin,
        transport: result.diagnostics?.transport,
        attemptedTransports: result.diagnostics?.attemptedTransports,
        transportAttempts: result.diagnostics?.transportAttempts
      });
      onProgress?.({ type: "source-complete", group, account, result });
    }
    return results;
  }

  async refresh(config, options = {}) {
    const now = this.clock();
    const bounds = windowBounds(config.settings, now);
    const work = [];
    for (const group of config.groups) {
      for (const account of group.accounts) {
        const hasScope = account.judge !== "codeforces" || account.scopes?.problemset !== false || account.scopes?.gym !== false;
        if (account.enabled && account.username && hasScope) work.push({ group, account });
      }
    }
    const settled = await Promise.all(work.map(({ group, account }) =>
      this.fetchAccount(group, account, bounds, options.signal, options.onProgress)
        .catch((error) => {
          this.diagnostics.add({ judge: account.judge, groupId: group.id, accountId: account.id, status: "network-error", message: error.message });
          options.onProgress?.({ type: "source-crash", group, account, error });
          const base = { groupId: group.id, accountId: account.id, username: account.username, from: bounds.from, to: bounds.to };
          if (account.judge === "codeforces") {
            const failures = [];
            if (account.scopes?.problemset !== false) failures.push(failureResult({ ...base, scope: "problemset" }, "codeforces", "problemset", error));
            if (account.scopes?.gym !== false) failures.push(failureResult({ ...base, scope: "gym" }, "codeforces", "gym", error));
            return failures;
          }
          return [failureResult({ ...base, scope: "default" }, account.judge, "default", error)];
        })
    ));
    const results = settled.flat();
    for (const result of results) {
      if (result.submissions.length) await this.store.mergeSubmissions(result.submissions);
      const { submissions: _submissions, ...sourceState } = result;
      await this.store.saveSourceState(sourceIdentity(result), sourceState);
    }
    const enabledAccountIds = new Set(work.map(({ account }) => account.id));
    const submissions = (await this.store.loadSubmissions({ from: bounds.from, to: bounds.to }))
      .filter((item) => enabledAccountIds.has(item.accountId));
    const stats = aggregateDaily(submissions, results, {
      dateKeys: bounds.dateKeys,
      now,
      timeZone: config.settings.timeZone
    });
    await this.store.saveDailyStats(stats);
    await this.store.pruneSubmissions(bounds.from - 7 * 86400000);
    const incompleteCount = results.filter((result) => result.status !== "ok" || result.coverage?.complete === false).length;
    await this.store.setAtomic("last-refresh", { at: now, dateKeys: bounds.dateKeys, sourceCount: results.length, incompleteCount });
    return { results, submissions, stats, bounds };
  }

  async loadDashboard(config) {
    const bounds = windowBounds(config.settings, this.clock());
    const [stats, submissions, lastRefresh] = await Promise.all([
      this.store.loadDailyStats({ fromDate: bounds.dateKeys[0], toDate: bounds.dateKeys.at(-1) }),
      this.store.loadSubmissions({ from: bounds.from, to: bounds.to }),
      this.store.get("last-refresh", null)
    ]);
    const enabledAccounts = new Map();
    for (const group of config.groups) {
      for (const account of group.accounts) {
        if (account.enabled) enabledAccounts.set(`${group.id}:${account.id}`, account);
      }
    }
    const enabledStat = (item) => {
      const account = enabledAccounts.get(`${item.groupId}:${item.accountId}`);
      if (!account || account.judge !== item.judge) return false;
      if (item.judge !== "codeforces") return item.scope === "default";
      return account.scopes?.[item.scope] !== false;
    };
    return {
      bounds,
      stats: stats.filter(enabledStat),
      submissions: mergeSubmissions([], submissions.filter(enabledStat)),
      lastRefresh
    };
  }
}

module.exports = { Diagnostics, FULL_REFRESH_INTERVAL_MS, MonitorService, firstDateEpoch, sourceIdentity, trustedSourceState, windowBounds };
