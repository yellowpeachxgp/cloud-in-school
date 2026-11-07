import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  RECOMMENDED_REDIS_TUNING,
  RespParser,
  RedisRespClient,
  RedisGatewayBuffer
} from "../packages/redis-buffer/src/index.mjs";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";

/**
 * Lightweight in-process RESP2 server for deterministic unit/CI testing of
 * TCP pipelining, AUTH, SELECT, GET/SET/PX, SCAN/UNLINK, INCR/PEXPIRE, and CONFIG SET/GET.
 */
function createEmbeddedResp2Server(expectedPassword = "test_redis_pass") {
  const kv = new Map();
  const config = new Map(
    Object.entries({
      maxmemory: "0",
      "maxmemory-policy": "noeviction",
      "maxmemory-samples": "5",
      "lazyfree-lazy-eviction": "no",
      "lazyfree-lazy-expire": "no",
      "lazyfree-lazy-server-del": "no",
      "replica-lazy-flush": "no",
      hz: "10",
      "dynamic-hz": "yes",
      "tcp-keepalive": "300",
      timeout: "0",
      activedefrag: "no",
      "slowlog-log-slower-than": "10000",
      "slowlog-max-len": "128",
      "no-appendfsync-on-rewrite": "no"
    })
  );

  function writeSimple(sock, str) {
    sock.write(`+${str}\r\n`);
  }
  function writeError(sock, msg) {
    sock.write(`-ERR ${msg}\r\n`);
  }
  function writeInt(sock, num) {
    sock.write(`:${num}\r\n`);
  }
  function writeBulk(sock, str) {
    if (str === null || str === undefined) {
      sock.write("$-1\r\n");
      return;
    }
    const s = String(str);
    sock.write(`$${Buffer.byteLength(s, "utf8")}\r\n${s}\r\n`);
  }
  function writeArray(sock, arr) {
    sock.write(`*${arr.length}\r\n`);
    for (const item of arr) {
      if (Array.isArray(item)) writeArray(sock, item);
      else writeBulk(sock, item);
    }
  }

  const server = net.createServer((sock) => {
    let authed = !expectedPassword;
    const parser = new RespParser((err, frame) => {
      if (err || !Array.isArray(frame) || frame.length === 0) {
        writeError(sock, "protocol error");
        return;
      }
      const cmd = String(frame[0]).toUpperCase();
      if (cmd === "AUTH") {
        if (frame[1] === expectedPassword) {
          authed = true;
          writeSimple(sock, "OK");
        } else {
          writeError(sock, "invalid password");
        }
        return;
      }
      if (!authed) {
        writeError(sock, "NOAUTH Authentication required");
        return;
      }
      if (cmd === "SELECT" || cmd === "PING") {
        writeSimple(sock, cmd === "PING" ? "PONG" : "OK");
        return;
      }
      if (cmd === "GET") {
        const entry = kv.get(frame[1]);
        if (!entry || (entry.expiresAt && Date.now() > entry.expiresAt)) {
          kv.delete(frame[1]);
          writeBulk(sock, null);
        } else {
          writeBulk(sock, entry.val);
        }
        return;
      }
      if (cmd === "SET") {
        const key = frame[1];
        const val = frame[2];
        let expiresAt = null;
        if (String(frame[3] || "").toUpperCase() === "PX") {
          expiresAt = Date.now() + Number(frame[4] || 60000);
        }
        kv.set(key, { val, expiresAt });
        writeSimple(sock, "OK");
        return;
      }
      if (cmd === "DEL" || cmd === "UNLINK") {
        let deleted = 0;
        for (let i = 1; i < frame.length; i++) {
          if (kv.delete(frame[i])) deleted++;
        }
        writeInt(sock, deleted);
        return;
      }
      if (cmd === "SCAN") {
        const matchIdx = frame.findIndex((x) => String(x).toUpperCase() === "MATCH");
        const pattern = matchIdx !== -1 ? String(frame[matchIdx + 1] || "*") : "*";
        const prefix = pattern.replace(/\*$/, "");
        const matched = Array.from(kv.keys()).filter((k) => k.startsWith(prefix));
        writeArray(sock, ["0", matched]);
        return;
      }
      if (cmd === "INCR") {
        const key = frame[1];
        const cur = Number(kv.get(key)?.val || 0) + 1;
        kv.set(key, { val: String(cur), expiresAt: kv.get(key)?.expiresAt || null });
        writeInt(sock, cur);
        return;
      }
      if (cmd === "PEXPIRE") {
        const entry = kv.get(frame[1]);
        if (entry) entry.expiresAt = Date.now() + Number(frame[2] || 60000);
        writeInt(sock, entry ? 1 : 0);
        return;
      }
      if (cmd === "CONFIG") {
        const sub = String(frame[1] || "").toUpperCase();
        if (sub === "SET") {
          config.set(String(frame[2]), String(frame[3]));
          writeSimple(sock, "OK");
          return;
        }
        if (sub === "GET") {
          const p = String(frame[2]);
          writeArray(sock, [p, config.get(p) ?? ""]);
          return;
        }
        if (sub === "REWRITE") {
          writeSimple(sock, "OK");
          return;
        }
      }
      if (cmd === "INFO") {
        const sec = String(frame[1] || "").toLowerCase();
        if (sec === "server") {
          writeBulk(sock, "redis_version:7.4.0\r\nuptime_in_seconds:3600\r\nhz:20\r\n");
        } else {
          writeBulk(
            sock,
            "used_memory_human:2.45M\r\nmaxmemory_human:1.00G\r\nmaxmemory_policy:allkeys-lru\r\nmem_fragmentation_ratio:1.08\r\n"
          );
        }
        return;
      }
      writeSimple(sock, "OK");
    });

    sock.on("data", (chunk) => parser.feed(chunk));
    sock.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        kv,
        config,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test("Redis Gateway Buffer: Native RESP2 pipelining, config tuning audit, 500-way singleflight stampede shield & write-through invalidation", async () => {
  const mockRedis = await createEmbeddedResp2Server("secret_pass_123");
  try {
    const redisBuffer = new RedisGatewayBuffer({
      enabled: true,
      host: "127.0.0.1",
      port: mockRedis.port,
      password: "secret_pass_123",
      db: 2,
      l1DefaultTtlMs: 500
    });

    // 1. Audit and tune Redis server configuration
    const tuneReport = await redisBuffer.auditAndTuneServerConfig({ applyTuning: true });
    assert.equal(tuneReport.connected, true);
    assert.equal(tuneReport.tuned, true, "All 14 high-concurrency Redis parameters must match after tuning");
    assert.equal(tuneReport.mismatches.length, 0);
    assert.equal(tuneReport.currentConfig["maxmemory-policy"], "allkeys-lru");
    assert.equal(tuneReport.currentConfig["lazyfree-lazy-eviction"], "yes");
    assert.equal(tuneReport.currentConfig.hz, "20");

    // 2. 500-concurrent-request Singleflight Stampede Coalescing test
    let upstreamComputeCalls = 0;
    const results = await Promise.all(
      Array.from({ length: 500 }, () =>
        redisBuffer.getOrCompute("stampede_test", "haut_catalog", 60, async () => {
          upstreamComputeCalls += 1;
          await new Promise((r) => setTimeout(r, 15));
          return { school: "河南工业大学", clubs: 3, competitions: 14 };
        })
      )
    );
    assert.equal(
      upstreamComputeCalls,
      1,
      "500 concurrent cache-miss requests must coalesce into exactly 1 upstream computation"
    );
    assert.equal(results.length, 500);
    assert.ok(redisBuffer.metrics.singleflight_coalesced >= 499);

    // 3. L1 expiry -> L2 Redis hit verification
    redisBuffer.l1Cache.clear();
    const l2Res = await redisBuffer.getOrCompute("stampede_test", "haut_catalog", 60, async () => {
      upstreamComputeCalls += 1;
      return { shouldNotRun: true };
    });
    assert.equal(l2Res.cacheStatus, "HIT-REDIS");
    assert.equal(l2Res.value.competitions, 14);
    assert.equal(upstreamComputeCalls, 1, "L2 Redis hit must not invoke computeFn");

    // 4. End-to-End CampusCloudApp integration with X-Cache headers & Admin write-through invalidation
    const app = createCampusCloudApp({ redisBuffer });
    const get1 = await app.inject({ method: "GET", url: "/api/v1/campus-content?school_id=haut" });
    assert.equal(get1.status, 200);
    assert.equal(get1.headers["x-cache"], "MISS");
    assert.equal(get1.body.data.competitions.length, 14);

    const get2 = await app.inject({ method: "GET", url: "/api/v1/campus-content?school_id=haut" });
    assert.equal(get2.headers["x-cache"], "HIT-L1");

    // Clear L1 to verify L2 Redis hit on gateway route
    redisBuffer.l1Cache.clear();
    const get3 = await app.inject({ method: "GET", url: "/api/v1/campus-content?school_id=haut" });
    assert.equal(get3.headers["x-cache"], "HIT-REDIS");

    // Admin updates competition -> write-through invalidation & pre-warming
    const adminUser = app.store.findOrCreateCloudUser({
      issuer: "https://sso.xpeach.codes",
      subject: "856f-cf51-b064-5d84",
      username: "yellowpeach",
      role: "admin"
    });
    const session = app.identity.issueDeviceSession(adminUser, "Admin", null, 1, Date.now());
    const upsertRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/campus-content/competitions",
      headers: { authorization: `Bearer ${session.access_token}` },
      body: {
        school_id: "haut",
        id: "comp_raicom",
        title: "睿抗机器人开发者大赛 (RAICOM)",
        short_title: "睿抗大赛",
        official_website_url: "https://www.raicom.com.cn"
      }
    });
    assert.equal(upsertRes.status, 200);

    // Immediate subsequent read must reflect the new 15th competition without stale cache
    const getAfterWrite = await app.inject({
      method: "GET",
      url: "/api/v1/campus-content?school_id=haut"
    });
    assert.equal(getAfterWrite.body.data.competitions.length, 15);

    // 5. Telemetry & /readyz verification
    const readyRes = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.body.data.redis_buffer.connected, true);
    assert.equal(readyRes.body.data.redis_buffer.server, undefined);

    await redisBuffer.client.close();
  } finally {
    await mockRedis.close();
  }
});
