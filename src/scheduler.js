"use strict";

const { createId, OJMonitorError } = require("./core");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

class LeaseCoordinator {
  constructor(store, options = {}) {
    this.store = store;
    this.ownerId = options.ownerId || createId("tab");
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || delay;
    this.random = options.random || Math.random;
  }

  leaseName(name) {
    return `lease:${name}`;
  }

  async acquire(name, options = {}) {
    const ttl = options.ttl || 30000;
    const attempts = options.attempts || 4;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const now = this.clock();
      const current = await this.store.get(this.leaseName(name), null);
      if (current && current.expiresAt > now && current.ownerId !== this.ownerId) {
        await this.sleep(Math.min(250 + Math.floor(this.random() * 500), Math.max(1, current.expiresAt - now)));
        continue;
      }
      const lease = {
        ownerId: this.ownerId,
        generation: Number(current?.generation || 0) + 1,
        expiresAt: now + ttl
      };
      await this.store.setAtomic(this.leaseName(name), lease);
      await this.sleep(Math.floor(this.random() * 25));
      const confirmed = await this.store.get(this.leaseName(name), null);
      if (confirmed?.ownerId === lease.ownerId && confirmed?.generation === lease.generation) return lease;
    }
    return null;
  }

  async renew(name, lease, ttl = 30000) {
    const current = await this.store.get(this.leaseName(name), null);
    if (!current || current.ownerId !== lease.ownerId || current.generation !== lease.generation) return false;
    const renewed = { ...current, expiresAt: this.clock() + ttl };
    await this.store.setAtomic(this.leaseName(name), renewed);
    const confirmed = await this.store.get(this.leaseName(name), null);
    if (confirmed?.ownerId === renewed.ownerId && confirmed?.generation === renewed.generation) {
      Object.assign(lease, renewed);
      return true;
    }
    return false;
  }

  async release(name, lease) {
    const current = await this.store.get(this.leaseName(name), null);
    if (current?.ownerId === lease.ownerId && current?.generation === lease.generation) {
      await this.store.delete(this.leaseName(name));
      return true;
    }
    return false;
  }

  async waitForRelease(name, options = {}) {
    const timeout = Number.isFinite(options.timeout) ? Math.max(1, options.timeout) : 30 * 60 * 1000;
    const pollInterval = Number.isFinite(options.pollInterval) ? Math.max(1, options.pollInterval) : 1000;
    const deadline = this.clock() + timeout;
    for (;;) {
      if (options.signal?.aborted) throw new OJMonitorError("network-error", "等待共享获取已取消");
      const completed = await options.isComplete?.();
      if (completed) return { reason: "completed", value: completed === true ? undefined : completed };
      const now = this.clock();
      const current = await this.store.get(this.leaseName(name), null);
      if (!current || current.expiresAt <= now || current.ownerId === this.ownerId) {
        return { reason: "available", lease: current };
      }
      if (now >= deadline) return { reason: "timeout", lease: current };
      await this.sleep(Math.min(pollInterval, Math.max(1, current.expiresAt - now), Math.max(1, deadline - now)));
    }
  }

  async runExclusive(name, task, options = {}) {
    const lease = await this.acquire(name, options);
    if (!lease) return { acquired: false, value: undefined };
    const ttl = options.ttl || 30000;
    const heartbeat = setInterval(() => {
      this.renew(name, lease, ttl).catch(() => undefined);
    }, Math.max(1000, Math.floor(ttl / 3)));
    try {
      return { acquired: true, value: await task(lease) };
    } finally {
      clearInterval(heartbeat);
      await this.release(name, lease);
    }
  }
}

class DomainRateLimiter {
  constructor(store, options = {}) {
    this.store = store;
    this.clock = options.clock || (() => Date.now());
    this.sleep = options.sleep || delay;
    this.chains = new Map();
  }

  async waitTurn(domain, minimumInterval) {
    const previous = this.chains.get(domain) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.chains.set(domain, tail);
    await previous;
    try {
      const key = `rate:${domain}`;
      const nextAllowedAt = Number(await this.store.get(key, 0));
      const wait = nextAllowedAt - this.clock();
      if (wait > 0) await this.sleep(wait);
      const reserved = this.clock() + minimumInterval;
      await this.store.setAtomic(key, reserved);
      return reserved;
    } finally {
      release();
      if (this.chains.get(domain) === tail) this.chains.delete(domain);
    }
  }

  async coolDown(domain, milliseconds) {
    const key = `rate:${domain}`;
    const current = Number(await this.store.get(key, 0));
    await this.store.setAtomic(key, Math.max(current, this.clock() + milliseconds));
  }
}

module.exports = { DomainRateLimiter, LeaseCoordinator, delay };
