"use strict";

const { buildSubmissionKey, defaultConfig, mergeSubmissions, normalizeConfig } = require("./core");

const PREFIX = "oj-monitor:v1:";

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

class MemoryBackend {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.listeners = new Map();
    this.nextListenerId = 1;
  }

  async get(key, fallback = undefined) {
    return this.values.has(key) ? this.values.get(key) : fallback;
  }

  async set(key, value) {
    const oldValue = this.values.get(key);
    this.values.set(key, value);
    for (const listener of this.listeners.values()) {
      if (listener.key === key) listener.callback(key, oldValue, value, false);
    }
  }

  async delete(key) {
    const oldValue = this.values.get(key);
    this.values.delete(key);
    for (const listener of this.listeners.values()) {
      if (listener.key === key) listener.callback(key, oldValue, undefined, false);
    }
  }

  async list() {
    return [...this.values.keys()];
  }

  addListener(key, callback) {
    const id = this.nextListenerId++;
    this.listeners.set(id, { key, callback });
    return id;
  }

  removeListener(id) {
    this.listeners.delete(id);
  }
}

class GMBackend {
  constructor(globalObject = globalThis) {
    this.global = globalObject;
    this.memoryFallback = new MemoryBackend();
  }

  async get(key, fallback = undefined) {
    if (typeof this.global.GM_getValue === "function") return await this.global.GM_getValue(key, fallback);
    return this.memoryFallback.get(key, fallback);
  }

  async set(key, value) {
    if (typeof this.global.GM_setValue === "function") return await this.global.GM_setValue(key, value);
    return this.memoryFallback.set(key, value);
  }

  async delete(key) {
    if (typeof this.global.GM_deleteValue === "function") return await this.global.GM_deleteValue(key);
    return this.memoryFallback.delete(key);
  }

  async list() {
    if (typeof this.global.GM_listValues === "function") return await this.global.GM_listValues();
    return this.memoryFallback.list();
  }

  addListener(key, callback) {
    if (typeof this.global.GM_addValueChangeListener === "function") {
      return this.global.GM_addValueChangeListener(key, callback);
    }
    return this.memoryFallback.addListener(key, callback);
  }

  removeListener(id) {
    if (typeof this.global.GM_removeValueChangeListener === "function") {
      return this.global.GM_removeValueChangeListener(id);
    }
    return this.memoryFallback.removeListener(id);
  }
}

function encodeEnvelope(value) {
  const payload = JSON.stringify(value);
  return JSON.stringify({ schemaVersion: 1, checksum: fnv1a(payload), payload });
}

function decodeEnvelope(serialized, fallback) {
  if (serialized === undefined || serialized === null) return fallback;
  if (typeof serialized !== "string") return serialized;
  const envelope = JSON.parse(serialized);
  if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.payload !== "string") {
    throw new Error("Unsupported storage envelope");
  }
  if (fnv1a(envelope.payload) !== envelope.checksum) throw new Error("Storage checksum mismatch");
  return JSON.parse(envelope.payload);
}

class Store {
  constructor(backend = new GMBackend()) {
    this.backend = backend;
  }

  key(name) {
    return `${PREFIX}${name}`;
  }

  async get(name, fallback = undefined) {
    const serialized = await this.backend.get(this.key(name));
    try {
      return decodeEnvelope(serialized, fallback);
    } catch (error) {
      if (error instanceof SyntaxError || /Storage checksum mismatch|Unsupported storage envelope/.test(error?.message || "")) {
        return fallback;
      }
      throw error;
    }
  }

  async setAtomic(name, value) {
    const key = this.key(name);
    const temporary = `${key}:tmp`;
    const encoded = encodeEnvelope(value);
    await this.backend.set(temporary, encoded);
    decodeEnvelope(await this.backend.get(temporary), undefined);
    await this.backend.set(key, encoded);
    decodeEnvelope(await this.backend.get(key), undefined);
    await this.backend.delete(temporary);
    return value;
  }

  async delete(name) {
    await this.backend.delete(this.key(name));
  }

  watch(name, callback) {
    return this.backend.addListener(this.key(name), (_key, oldValue, newValue, remote) => {
      let decodedOld;
      let decodedNew;
      try {
        decodedOld = decodeEnvelope(oldValue, undefined);
        decodedNew = decodeEnvelope(newValue, undefined);
      } catch (error) {
        callback(undefined, undefined, remote, error);
        return;
      }
      callback(decodedNew, decodedOld, remote, null);
    });
  }

  unwatch(listenerId) {
    this.backend.removeListener(listenerId);
  }

  async loadConfig() {
    return normalizeConfig(await this.get("config", defaultConfig()));
  }

  async saveConfig(config) {
    const normalized = normalizeConfig(config);
    await this.setAtomic("config", normalized);
    return normalized;
  }

  monthChunkName(submission) {
    const date = new Date(submission.submittedAt);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return `submissions:${submission.accountId}:${submission.judge}:${submission.scope}:${month}`;
  }

  async mergeSubmissions(submissions) {
    const incoming = mergeSubmissions([], submissions);
    if (!incoming.length) return;
    const chunks = new Map();
    for (const submission of incoming) {
      const name = this.monthChunkName(submission);
      if (!chunks.has(name)) chunks.set(name, []);
      chunks.get(name).push(submission);
    }
    const storedIndex = await this.get("submission-index", []);
    const index = new Set(Array.isArray(storedIndex) ? storedIndex.filter((name) => typeof name === "string") : []);
    for (const name of chunks.keys()) index.add(name);
    const incomingKeys = new Set(incoming.map(buildSubmissionKey));
    for (const name of index) {
      const storedItems = await this.get(name, []);
      const existing = (Array.isArray(storedItems) ? storedItems : [])
        .flatMap((item) => {
          try { return mergeSubmissions([], [item]); } catch { return []; }
        })
        .filter((item) => !incomingKeys.has(buildSubmissionKey(item)));
      const merged = mergeSubmissions(existing, chunks.get(name) || []);
      if (merged.length || chunks.has(name)) {
        await this.setAtomic(name, merged);
      } else {
        await this.delete(name);
        index.delete(name);
      }
    }
    await this.setAtomic("submission-index", [...index].sort());
  }

  async loadSubmissions(filter = {}) {
    const storedIndex = await this.get("submission-index", []);
    const names = Array.isArray(storedIndex) ? storedIndex.filter((name) => typeof name === "string") : [];
    const output = [];
    for (const name of names) {
      const storedItems = await this.get(name, []);
      const items = Array.isArray(storedItems) ? storedItems : [];
      for (const item of items) {
        let normalized;
        try { normalized = mergeSubmissions([], [item])[0]; } catch { continue; }
        if (filter.accountId && normalized.accountId !== filter.accountId) continue;
        if (filter.judge && normalized.judge !== filter.judge) continue;
        if (filter.scope && normalized.scope !== filter.scope) continue;
        if (Number.isFinite(filter.from) && normalized.submittedAt < filter.from) continue;
        if (Number.isFinite(filter.to) && normalized.submittedAt > filter.to) continue;
        output.push(normalized);
      }
    }
    return mergeSubmissions([], output);
  }

  async removeAccount(accountId) {
    const storedSubmissionIndex = await this.get("submission-index", []);
    const names = Array.isArray(storedSubmissionIndex) ? storedSubmissionIndex.filter((name) => typeof name === "string") : [];
    const keep = [];
    for (const name of names) {
      if (name.startsWith(`submissions:${accountId}:`)) await this.delete(name);
      else keep.push(name);
    }
    await this.setAtomic("submission-index", keep);
    const storedStatsIndex = await this.get("stats-index", []);
    const statNames = Array.isArray(storedStatsIndex) ? storedStatsIndex.filter((name) => typeof name === "string") : [];
    const keepStats = [];
    for (const name of statNames) {
      const parts = name.split(":");
      if (parts[0] === "stats" && parts[2] === accountId) await this.delete(name);
      else keepStats.push(name);
    }
    await this.setAtomic("stats-index", keepStats);
    const sourcePrefix = `${PREFIX}source:`;
    for (const key of await this.backend.list()) {
      if (!key.startsWith(sourcePrefix)) continue;
      const parts = key.slice(PREFIX.length).split(":");
      if (parts[0] === "source" && parts[2] === accountId) await this.backend.delete(key);
    }
  }

  async pruneSubmissions(cutoff) {
    const storedIndex = await this.get("submission-index", []);
    const names = Array.isArray(storedIndex) ? storedIndex.filter((name) => typeof name === "string") : [];
    const keep = [];
    for (const name of names) {
      const storedItems = await this.get(name, []);
      const retained = (Array.isArray(storedItems) ? storedItems : []).filter((item) => Number(item?.submittedAt) >= cutoff);
      if (retained.length) {
        await this.setAtomic(name, retained);
        keep.push(name);
      } else {
        await this.delete(name);
      }
    }
    await this.setAtomic("submission-index", keep);
  }

  async saveDailyStats(stats) {
    const chunks = new Map();
    for (const stat of stats) {
      const year = stat.date.slice(0, 4);
      const name = `stats:${stat.groupId}:${stat.accountId}:${stat.judge}:${stat.scope}:${year}`;
      if (!chunks.has(name)) chunks.set(name, []);
      chunks.get(name).push(stat);
    }
    const storedIndex = await this.get("stats-index", []);
    const index = new Set(Array.isArray(storedIndex) ? storedIndex.filter((name) => typeof name === "string") : []);
    for (const [name, incoming] of chunks) {
      const existing = await this.get(name, []);
      const merged = new Map(existing.map((item) => [[item.groupId, item.accountId, item.judge, item.scope, item.date].join(":"), item]));
      for (const item of incoming) merged.set([item.groupId, item.accountId, item.judge, item.scope, item.date].join(":"), item);
      await this.setAtomic(name, [...merged.values()].sort((left, right) => left.date.localeCompare(right.date)));
      index.add(name);
    }
    await this.setAtomic("stats-index", [...index].sort());
  }

  async loadDailyStats(filter = {}) {
    const storedIndex = await this.get("stats-index", []);
    const names = Array.isArray(storedIndex) ? storedIndex.filter((name) => typeof name === "string") : [];
    const stats = [];
    for (const name of names) {
      const storedStats = await this.get(name, []);
      for (const stat of Array.isArray(storedStats) ? storedStats : []) {
        if (filter.groupId && stat.groupId !== filter.groupId) continue;
        if (filter.accountId && stat.accountId !== filter.accountId) continue;
        if (filter.fromDate && stat.date < filter.fromDate) continue;
        if (filter.toDate && stat.date > filter.toDate) continue;
        stats.push(stat);
      }
    }
    return stats;
  }

  async saveSourceState(identity, state) {
    const previous = await this.loadSourceState(identity);
    const previousTrusted = previous?.trusted || (previous?.coverage?.complete === true
      ? Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "trusted"))
      : null);
    const current = Object.fromEntries(Object.entries(state || {}).filter(([key]) => key !== "trusted"));
    const trusted = current?.coverage?.complete === true ? current : previousTrusted;
    return this.setAtomic(`source:${identity}`, { ...current, ...(trusted ? { trusted } : {}) });
  }

  async loadSourceState(identity) {
    return this.get(`source:${identity}`, null);
  }

  async debugSnapshot() {
    const keys = (await this.backend.list()).filter((key) => key.startsWith(PREFIX) && !key.endsWith(":tmp"));
    return { keys: keys.sort(), submissionKeys: (await this.loadSubmissions()).map(buildSubmissionKey) };
  }
}

module.exports = { GMBackend, MemoryBackend, Store, decodeEnvelope, encodeEnvelope, fnv1a, PREFIX };
