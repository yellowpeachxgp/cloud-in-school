import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";

/**
 * ============================================================================
 * Day in School — High-Concurrency Redis Gateway Buffer & Singleflight Engine
 * (`packages/redis-buffer/src/index.mjs`)
 *
 * Features:
 * 1. Native Pipelined RESP2 TCP Client (`RedisRespClient`) with TCP_NODELAY,
 *    TCP KeepAlive, automatic AUTH/SELECT, and FIFO command multiplexing.
 * 2. Two-Tier Cache Architecture:
 *    - L1 Hot Micro-Cache (in-memory LRU-bounded, 1.5s burst shield)
 *    - L2 Redis Distributed Cache (`dis:cache:*`, jittered TTLs to prevent
 *      avalanche, negative caching to prevent penetration)
 * 3. Singleflight Stampede Coalescing: 1,000 concurrent requests for an
 *    un-cached key trigger exactly 1 upstream/store computation.
 * 4. Write-Through Pre-Warming & Prefix Invalidation on Admin Mutations.
 * 5. Redis-Backed Atomic Rate Limiter (`dis:rl:*`) & Server Config Auditor.
 * ============================================================================
 */

export const RECOMMENDED_REDIS_TUNING = Object.freeze({
  maxmemory: "1073741824", // 1 GiB dedicated ceiling
  "maxmemory-policy": "allkeys-lru",
  "maxmemory-samples": "10",
  "lazyfree-lazy-eviction": "yes",
  "lazyfree-lazy-expire": "yes",
  "lazyfree-lazy-server-del": "yes",
  "replica-lazy-flush": "yes",
  hz: "20",
  "dynamic-hz": "yes",
  "tcp-keepalive": "60",
  timeout: "300",
  activedefrag: "yes",
  "slowlog-log-slower-than": "5000",
  "slowlog-max-len": "256",
  "no-appendfsync-on-rewrite": "yes"
});

function encodeRespCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const str = String(arg ?? "");
    const byteLen = Buffer.byteLength(str, "utf8");
    parts.push(`$${byteLen}\r\n${str}\r\n`);
  }
  return parts.join("");
}

/**
 * Incremental RESP2 protocol parser supporting pipelined responses,
 * bulk strings with UTF-8 multi-byte characters, nested arrays, integers, and errors.
 */
export class RespParser {
  constructor(onFrame) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
  }

  feed(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const parsed = this._parseNext(0);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.nextOffset);
      this.onFrame(parsed.error, parsed.value);
    }
  }

  _findCrlf(offset) {
    for (let i = offset; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
        return i;
      }
    }
    return -1;
  }

  _parseNext(offset) {
    if (offset >= this.buffer.length) return null;
    const prefix = this.buffer[offset];
    const lineEnd = this._findCrlf(offset);
    if (lineEnd === -1) return null;
    const header = this.buffer.subarray(offset + 1, lineEnd).toString("utf8");
    const afterLine = lineEnd + 2;

    // '+' Simple String
    if (prefix === 43) {
      return { error: null, value: header, nextOffset: afterLine };
    }
    // '-' Error
    if (prefix === 45) {
      return { error: new Error(header), value: null, nextOffset: afterLine };
    }
    // ':' Integer
    if (prefix === 58) {
      return { error: null, value: Number(header), nextOffset: afterLine };
    }
    // '$' Bulk String
    if (prefix === 36) {
      const len = Number(header);
      if (len === -1) {
        return { error: null, value: null, nextOffset: afterLine };
      }
      const endBulk = afterLine + len;
      if (this.buffer.length < endBulk + 2) return null;
      const val = this.buffer.subarray(afterLine, endBulk).toString("utf8");
      return { error: null, value: val, nextOffset: endBulk + 2 };
    }
    // '*' Array
    if (prefix === 42) {
      const count = Number(header);
      if (count === -1) {
        return { error: null, value: null, nextOffset: afterLine };
      }
      const items = [];
      let cursor = afterLine;
      for (let i = 0; i < count; i++) {
        const elem = this._parseNext(cursor);
        if (!elem) return null;
        if (elem.error) return elem;
        items.push(elem.value);
        cursor = elem.nextOffset;
      }
      return { error: null, value: items, nextOffset: cursor };
    }

    throw new Error(`Unsupported RESP frame byte: ${prefix}`);
  }
}

export class RedisRespClient {
  constructor(options = {}) {
    const parsedUrl = options.url ? new URL(options.url) : null;
    const defaultUnixSock = "/opt/1panel/apps/redis/redis/data/redis.sock";
    this.socketPath =
      options.socketPath ||
      process.env.REDIS_SOCKET_PATH ||
      (!options.host && !options.port && !options.url && fs.existsSync(defaultUnixSock)
        ? defaultUnixSock
        : "");
    this.host = options.host || parsedUrl?.hostname || process.env.REDIS_HOST || "127.0.0.1";
    this.port = Number(options.port || parsedUrl?.port || process.env.REDIS_PORT || 6379);
    this.password =
      options.password ??
      (parsedUrl?.password ? decodeURIComponent(parsedUrl.password) : undefined) ??
      process.env.REDIS_PASSWORD ??
      "";
    this.db = Number(
      options.db ??
        (parsedUrl?.pathname && parsedUrl.pathname.length > 1
          ? parsedUrl.pathname.slice(1)
          : process.env.REDIS_DB || 0)
    );
    this.connectTimeoutMs = Number(options.connectTimeoutMs || 1500);
    this.commandTimeoutMs = Number(options.commandTimeoutMs || 1200);
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;

    this.socket = null;
    this.connected = false;
    this.ready = false;
    this.connectingPromise = null;
    this.queue = [];
    this.parser = new RespParser((err, val) => this._handleFrame(err, val));
  }

  async connect() {
    if (!this.enabled) return false;
    if (this.ready && this.socket && !this.socket.destroyed) return true;
    if (this.connectingPromise) return this.connectingPromise;

    this.parser.buffer = Buffer.alloc(0);
    this.connectingPromise = new Promise((resolve) => {
      const sock = this.socketPath
        ? net.createConnection({ path: this.socketPath })
        : net.createConnection({
            host: this.host,
            port: this.port
          });
      this.socket = sock;
      if (!this.socketPath) {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 30_000);
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          this.connectingPromise = null;
          resolve(false);
        }
      }, this.connectTimeoutMs);

      sock.on("data", (chunk) => {
        if (this.socket !== sock) return;
        try {
          this.parser.feed(chunk);
        } catch {
          sock.destroy();
        }
      });

      sock.on("error", () => {
        if (this.socket !== sock) return;
        this._failQueue(new Error("Redis socket error"));
        this.connected = false;
        this.ready = false;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.connectingPromise = null;
          resolve(false);
        }
      });

      sock.on("close", () => {
        if (this.socket !== sock) return;
        this._failQueue(new Error("Redis socket closed"));
        this.connected = false;
        this.ready = false;
        this.connectingPromise = null;
      });

      sock.on("connect", async () => {
        this.socket = sock;
        this.connected = true;
        try {
          if (this.password) {
            await this._sendRaw(["AUTH", this.password]);
          }
          if (this.db > 0) {
            await this._sendRaw(["SELECT", String(this.db)]);
          }
          this.ready = true;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.connectingPromise = null;
            resolve(true);
          }
        } catch {
          sock.destroy();
          this.ready = false;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.connectingPromise = null;
            resolve(false);
          }
        }
      });
    });

    return this.connectingPromise;
  }

  _handleFrame(err, val) {
    const item = this.queue.shift();
    if (!item) return;
    clearTimeout(item.timer);
    if (err) item.reject(err);
    else item.resolve(val);
  }

  _failQueue(err) {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      clearTimeout(item.timer);
      item.reject(err);
    }
  }

  _sendRaw(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed || !this.connected) {
        reject(new Error("Redis socket not connected"));
        return;
      }
      const timer = setTimeout(() => {
        // RESP has no request IDs. A timed-out response must never shift onto
        // another command: discard this connection and every pending waiter.
        this.ready = false;
        this.connected = false;
        this._failQueue(new Error(`Redis command timeout: ${args[0]}`));
        this.parser.buffer = Buffer.alloc(0);
        this.socket?.destroy();
      }, this.commandTimeoutMs);

      this.queue.push({ resolve, reject, timer });
      this.socket.write(encodeRespCommand(args));
    });
  }

  async sendCommand(args) {
    if (!this.enabled) throw new Error("Redis disabled");
    if (!this.ready) {
      const ok = await this.connect();
      if (!ok) throw new Error("Redis connection unavailable");
    }
    return this._sendRaw(args);
  }

  async close() {
    this.enabled = false;
    this.ready = false;
    this.connected = false;
    this._failQueue(new Error("Redis client closed"));
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
  }
}

export class RedisGatewayBuffer {
  constructor(options = {}) {
    this.keyPrefix = options.keyPrefix || process.env.REDIS_KEY_PREFIX || "dis:";
    this.l1MaxEntries = Number(options.l1MaxEntries || 2048);
    this.l1DefaultTtlMs = Number(options.l1DefaultTtlMs || 1500);
    this.jitterRatio = Number(options.jitterRatio ?? 0.1);
    this.client = options.client || new RedisRespClient(options);

    // L1 in-memory hot burst cache: key -> { value, expiresAtMs, cachedAtIso }
    this.l1Cache = new Map();
    // Singleflight in-flight promises: key -> Promise<{ value, fromRedis }>
    this.inFlight = new Map();
    // Local fallback rate limit buckets when Redis is disabled or unreachable
    this.localRateLimits = new Map();

    // Telemetry counters
    this.metrics = {
      l1_hits: 0,
      l2_redis_hits: 0,
      misses: 0,
      singleflight_coalesced: 0,
      negative_cache_hits: 0,
      redis_writes: 0,
      redis_invalidations: 0,
      redis_errors: 0,
      rate_limit_checks: 0,
      rate_limit_blocked: 0,
      total_read_latency_usec: 0,
      total_reads: 0
    };
  }

  _fullKey(namespace, key) {
    return `${this.keyPrefix}cache:${namespace}:${key}`;
  }

  _computeJitteredTtlMs(baseTtlSeconds) {
    const baseMs = Math.max(1000, Math.round(Number(baseTtlSeconds || 60) * 1000));
    if (this.jitterRatio <= 0) return baseMs;
    const delta = Math.round(baseMs * this.jitterRatio * (Math.random() * 2 - 1));
    return Math.max(1000, baseMs + delta);
  }

  _setL1(fullKey, value, ttlMs = this.l1DefaultTtlMs) {
    if (this.l1Cache.size >= this.l1MaxEntries) {
      const oldestKey = this.l1Cache.keys().next().value;
      if (oldestKey !== undefined) this.l1Cache.delete(oldestKey);
    }
    this.l1Cache.set(fullKey, {
      value,
      expiresAtMs: Date.now() + Math.max(200, ttlMs)
    });
  }

  _getL1(fullKey) {
    const entry = this.l1Cache.get(fullKey);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAtMs) {
      this.l1Cache.delete(fullKey);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Read-Through Multi-Tier Cache with Singleflight Stampede Coalescing.
   * Returns `{ value, cacheStatus: "HIT-L1" | "HIT-REDIS" | "COALESCED" | "MISS" }`.
   */
  async getOrCompute(namespace, key, ttlSeconds, computeFn, options = {}) {
    const startHr = process.hrtime.bigint();
    const fullKey = this._fullKey(namespace, key);
    const l1TtlMs = options.l1TtlMs ?? Math.min(this.l1DefaultTtlMs, ttlSeconds * 1000);

    try {
      // 1) Check L1 micro-cache
      const l1Val = this._getL1(fullKey);
      if (l1Val !== undefined) {
        this.metrics.l1_hits += 1;
        return { value: l1Val, cacheStatus: "HIT-L1" };
      }

      // 2) Singleflight coalescing check (if another request is already fetching L2/computing)
      if (this.inFlight.has(fullKey)) {
        this.metrics.singleflight_coalesced += 1;
        const coalescedRes = await this.inFlight.get(fullKey);
        return { value: coalescedRes.value, cacheStatus: "COALESCED" };
      }

      const flightState = { invalidated: false };
      const flightPromise = (async () => {
        // 3) Check L2 Redis distributed buffer
        if (this.client.enabled) {
          try {
            const raw = await this.client.sendCommand(["GET", fullKey]);
            if (raw !== null && raw !== undefined) {
              const parsed = JSON.parse(raw);
              if (parsed && parsed.__negative_cache === true) {
                this.metrics.negative_cache_hits += 1;
                const negErr = new Error(parsed.message || "Cached not found");
                negErr.code = parsed.code || "NOT_FOUND";
                negErr.fromNegativeCache = true;
                throw negErr;
              }
              if (!flightState.invalidated) this._setL1(fullKey, parsed, l1TtlMs);
              this.metrics.l2_redis_hits += 1;
              return { value: parsed, fromRedis: true };
            }
          } catch (err) {
            if (err.fromNegativeCache) throw err;
            this.metrics.redis_errors += 1;
          }
        }

        // 4) Cache miss -> execute authoritative computeFn
        this.metrics.misses += 1;
        try {
          const freshValue = await computeFn();
          if (!flightState.invalidated) this._setL1(fullKey, freshValue, l1TtlMs);
          if (!flightState.invalidated && this.client.enabled && freshValue !== undefined) {
            const jitteredMs = this._computeJitteredTtlMs(ttlSeconds);
            this.client
              .sendCommand(["SET", fullKey, JSON.stringify(freshValue), "PX", String(jitteredMs)])
              .then(() => {
                this.metrics.redis_writes += 1;
              })
              .catch(() => {
                this.metrics.redis_errors += 1;
              });
          }
          return { value: freshValue, fromRedis: false };
        } catch (computeErr) {
          // Negative-cache NOT_FOUND errors for 15s to prevent cache penetration attacks
          if (!flightState.invalidated && computeErr?.code === "NOT_FOUND" && this.client.enabled) {
            const negPayload = JSON.stringify({
              __negative_cache: true,
              code: "NOT_FOUND",
              message: computeErr.message
            });
            this.client
              .sendCommand(["SET", fullKey, negPayload, "PX", "15000"])
              .catch(() => {});
          }
          throw computeErr;
        }
      })();

      flightPromise.invalidationState = flightState;
      this.inFlight.set(fullKey, flightPromise);

      try {
        const res = await flightPromise;
        return {
          value: res.value,
          cacheStatus: res.fromRedis ? "HIT-REDIS" : "MISS"
        };
      } finally {
        if (this.inFlight.get(fullKey) === flightPromise) this.inFlight.delete(fullKey);
      }
    } finally {
      const elapsedUsec = Number(process.hrtime.bigint() - startHr) / 1000;
      this.metrics.total_read_latency_usec += elapsedUsec;
      this.metrics.total_reads += 1;
    }
  }

  /**
   * Write-through pre-warming + immediate invalidation of a namespace or specific key.
   */
  async setAndWarm(namespace, key, value, ttlSeconds = 120) {
    const fullKey = this._fullKey(namespace, key);
    const pending = this.inFlight.get(fullKey);
    if (pending) { pending.invalidationState.invalidated = true; this.inFlight.delete(fullKey); }
    this._setL1(fullKey, value, Math.min(this.l1DefaultTtlMs, ttlSeconds * 1000));
    if (!this.client.enabled) return;
    try {
      const jitteredMs = this._computeJitteredTtlMs(ttlSeconds);
      await this.client.sendCommand(["SET", fullKey, JSON.stringify(value), "PX", String(jitteredMs)]);
      this.metrics.redis_writes += 1;
    } catch {
      this.metrics.redis_errors += 1;
    }
  }

  async invalidate(namespace, key = null) {
    const prefix = key ? this._fullKey(namespace, key) : `${this.keyPrefix}cache:${namespace}:`;
    for (const [k, pending] of this.inFlight) {
      if (key ? k === prefix : k.startsWith(prefix)) {
        pending.invalidationState.invalidated = true;
        this.inFlight.delete(k);
      }
    }
    for (const k of this.l1Cache.keys()) {
      if (k === prefix || k.startsWith(prefix)) {
        this.l1Cache.delete(k);
      }
    }
    this.metrics.redis_invalidations += 1;
    if (!this.client.enabled) return;
    try {
      if (key) {
        await this.client.sendCommand(["DEL", prefix]);
      } else {
        // Use non-blocking SCAN + UNLINK to purge namespace keys safely under high concurrency
        let cursor = "0";
        do {
          const scanRes = await this.client.sendCommand([
            "SCAN",
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            "100"
          ]);
          cursor = String(scanRes?.[0] || "0");
          const keys = Array.isArray(scanRes?.[1]) ? scanRes[1] : [];
          if (keys.length > 0) {
            await this.client.sendCommand(["UNLINK", ...keys]);
          }
        } while (cursor !== "0");
      }
    } catch {
      this.metrics.redis_errors += 1;
    }
  }

  /**
   * Redis-backed atomic fixed-window rate limiter (`INCR` + `PEXPIRE`) with local in-memory fallback.
   */
  async checkRateLimit(bucketKey, maxRequests = 120, windowSeconds = 60, nowMs = Date.now()) {
    this.metrics.rate_limit_checks += 1;
    const windowMs = Math.max(1000, windowSeconds * 1000);
    const slot = Math.floor(nowMs / windowMs);
    const rlKey = `${this.keyPrefix}rl:${bucketKey}:${slot}`;

    const checkLocalFallback = () => {
      if (this.localRateLimits.size > 4096) {
        for (const [k, v] of this.localRateLimits.entries()) {
          if (nowMs > v.expiresAtMs) this.localRateLimits.delete(k);
        }
        if (this.localRateLimits.size > 4096) {
          const oldest = this.localRateLimits.keys().next().value;
          if (oldest !== undefined) this.localRateLimits.delete(oldest);
        }
      }
      let entry = this.localRateLimits.get(rlKey);
      if (!entry || nowMs > entry.expiresAtMs) {
        entry = { count: 0, expiresAtMs: (slot + 1) * windowMs };
        this.localRateLimits.set(rlKey, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= maxRequests;
      if (!allowed) this.metrics.rate_limit_blocked += 1;
      return {
        allowed,
        current: entry.count,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - entry.count)
      };
    };

    if (!this.client.enabled) {
      return checkLocalFallback();
    }
    try {
      const count = Number(await this.client.sendCommand(["INCR", rlKey]));
      if (count === 1) {
        this.client.sendCommand(["PEXPIRE", rlKey, String(windowMs)]).catch(() => {});
      }
      const allowed = count <= maxRequests;
      if (!allowed) this.metrics.rate_limit_blocked += 1;
      return {
        allowed,
        current: count,
        limit: maxRequests,
        remaining: Math.max(0, maxRequests - count)
      };
    } catch {
      return checkLocalFallback();
    }
  }

  /**
   * Audit and apply production high-concurrency tuning on the live Redis server.
   */
  async auditAndTuneServerConfig({ applyTuning = false } = {}) {
    const currentConfig = {};
    const mismatches = [];
    if (!this.client.enabled) {
      return { connected: false, tuned: false, currentConfig, mismatches };
    }
    try {
      if (applyTuning) {
        for (const [param, targetVal] of Object.entries(RECOMMENDED_REDIS_TUNING)) {
          await this.client.sendCommand(["CONFIG", "SET", param, targetVal]).catch(() => {});
        }
        await this.client.sendCommand(["CONFIG", "REWRITE"]).catch(() => {});
      }

      for (const [param, expectedVal] of Object.entries(RECOMMENDED_REDIS_TUNING)) {
        const res = await this.client.sendCommand(["CONFIG", "GET", param]);
        const actualVal = Array.isArray(res) && res.length >= 2 ? String(res[1]) : null;
        currentConfig[param] = actualVal;
        if (actualVal !== expectedVal) {
          mismatches.push({ param, expected: expectedVal, actual: actualVal });
        }
      }
      return {
        connected: true,
        tuned: mismatches.length === 0,
        currentConfig,
        mismatches
      };
    } catch (err) {
      return {
        connected: false,
        tuned: false,
        error: err.message,
        currentConfig,
        mismatches
      };
    }
  }

  async getTelemetrySnapshot() {
    const totalHits = this.metrics.l1_hits + this.metrics.l2_redis_hits + this.metrics.singleflight_coalesced;
    const totalLookups = totalHits + this.metrics.misses;
    const hitRatePct = totalLookups > 0 ? Number(((totalHits / totalLookups) * 100).toFixed(2)) : 100;
    const avgLatencyMs =
      this.metrics.total_reads > 0
        ? Number((this.metrics.total_read_latency_usec / this.metrics.total_reads / 1000).toFixed(3))
        : 0;

    let serverInfo = null;
    if (this.client.enabled) {
      try {
        const rawInfo = await this.client.sendCommand(["INFO", "server"]);
        const rawMem = await this.client.sendCommand(["INFO", "memory"]);
        const parseInfo = (txt) => {
          const map = {};
          for (const line of String(txt || "").split(/\r?\n/)) {
            const idx = line.indexOf(":");
            if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
          return map;
        };
        const sMap = parseInfo(rawInfo);
        const mMap = parseInfo(rawMem);
        serverInfo = {
          redis_version: sMap.redis_version || "unknown",
          uptime_in_seconds: Number(sMap.uptime_in_seconds || 0),
          hz: Number(sMap.hz || 10),
          used_memory_human: mMap.used_memory_human || "0B",
          maxmemory_human: mMap.maxmemory_human || "0B",
          maxmemory_policy: mMap.maxmemory_policy || "unknown",
          mem_fragmentation_ratio: Number(mMap.mem_fragmentation_ratio || 1)
        };
      } catch {
        serverInfo = null;
      }
    }

    return {
      enabled: this.client.enabled,
      connected: Boolean(this.client.ready && serverInfo),
      transport: this.client.socketPath ? `unix:${this.client.socketPath}` : `tcp://${this.client.host}:${this.client.port}`,
      host: this.client.host,
      port: this.client.port,
      db: this.client.db,
      key_prefix: this.keyPrefix,
      l1_entries: this.l1Cache.size,
      in_flight_keys: this.inFlight.size,
      hit_rate_pct: hitRatePct,
      avg_read_latency_ms: avgLatencyMs,
      counters: { ...this.metrics },
      server: serverInfo
    };
  }
}
