import { route } from "./route-table.mjs";
import {
  ContractError,
  loadOpenApiText
} from "../../../../packages/contracts/src/index.mjs";

export function createSystemRoutes(ctx) {
  const {
    store,
    kmsVault,
    redisBuffer,
    isDraining
  } = ctx;

  return [
  route("GET", "/healthz", "getHealthz", "none", async () => {
    const redisTelemetry = await redisBuffer.getTelemetrySnapshot();
    return {
      status: 200,
      code: "HEALTH_OK",
      data: {
        service: "cloud-in-school",
        status: "ok",
        version: "4.1.0",
        redis_buffer: {
          enabled: redisTelemetry.enabled,
          connected: redisTelemetry.connected,
          hit_rate_pct: redisTelemetry.hit_rate_pct,
          l1_entries: redisTelemetry.l1_entries
        }
      }
    };
  }),

  route("GET", "/readyz", "getReadyz", "none", async () => {
    // HTTP 状态是负载均衡器的准入依据，不能只在 200 响应体里写 ready=false。
    if (isDraining() || !kmsVault.kmsOnline) {
      throw new ContractError("READINESS_UNAVAILABLE", "服务正在排空或密钥服务不可用，请稍后重试");
    }
    const redisTelemetry = await redisBuffer.getTelemetrySnapshot();
    // 读取遥测期间也可能收到停机信号。
    if (isDraining() || !kmsVault.kmsOnline) {
      throw new ContractError("READINESS_UNAVAILABLE", "服务就绪状态已变化，请稍后重试");
    }
    return {
      status: 200,
      code: "READY_OK",
      data: {
        ready: kmsVault.kmsOnline,
        migrations_applied: Array.from(store.appliedMigrations),
        school_providers: ["school.haut.library"],
        redis_buffer: { connected: Boolean(redisTelemetry?.connected) }
      }
    };
  }),

  route("GET", "/api/v1/openapi.json", "getOpenApiSpec", "none", async () => ({
    status: 200,
    code: "OPENAPI_SPEC",
    data: {
      openapi: "3.1.2",
      spec_yaml_length: loadOpenApiText().length,
      registered_operations: ctx.getCoreRouteCount()
    }
  }))
  ];
}
