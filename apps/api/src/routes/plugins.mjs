import { route } from "./route-table.mjs";
import {
  ContractError
} from "../../../../packages/contracts/src/index.mjs";

export function createPluginsRoutes(ctx) {
  const {
    parcelHub,
    pluginBroker,
    referencePluginLoadStatus = []
  } = ctx;

  return [
  route("GET", "/api/v1/plugins/registry", "listRegisteredPlugins", "public", async () => ({
    status: 200,
    code: "PLUGIN_REGISTRY_OK",
    data: { plugins: pluginBroker.listAvailablePlugins() }
  })),

  route("POST", "/api/v1/plugins/install", "installSignedPlugin", "bearer", async ({ auth, body }) => {
    const suppliedPublicKeyBase64 = body?.public_key_base64;
    if (suppliedPublicKeyBase64 !== undefined && typeof suppliedPublicKeyBase64 !== "string") {
      throw new ContractError("BAD_REQUEST", "public_key_base64 must be a base64 Ed25519 SPKI string when supplied");
    }
    if (body?.manifest) {
      const canOverridePublicKey =
        Array.isArray(auth?.roles) &&
        (auth.roles.includes("PLATFORM_OWNER") || auth.roles.includes("ADMIN"));
      // W6-01a trust-root rule: production accepts only the explicit
      // publisher-id → public-key trust root configured on the host. Admin
      // roles never bypass that root; the broker performs the authoritative
      // fail-closed check for every caller.
      // A client-supplied public key is only a consistency proof for the
      // current contract-transitional install shape. The broker compares it
      // with the host-configured publisher trust root (or the non-production
      // pinning rule); it never becomes trust input by itself.
      pluginBroker.registerPluginPackage({
        manifest: body.manifest,
        artifactMap: body.artifact_map || body.artifact_payloads || {},
        publicKeyBase64: suppliedPublicKeyBase64 ?? null,
        actorUserId: auth.cloudUserId,
        isAdmin: canOverridePublicKey
      });
    }
    const pluginId = body?.plugin_id || body?.manifest?.plugin_id;
    const inst = pluginBroker.installPluginForUser(auth.cloudUserId, pluginId, {
      version: body?.version || body?.manifest?.version,
      schoolId: body?.school_id || undefined,
      publicKeyBase64: suppliedPublicKeyBase64 ?? null
    });
    return { status: 201, code: "PLUGIN_INSTALLED", data: inst };
  }),

  route(
    "POST",
    "/api/v1/plugins/{pluginId}/lifecycle",
    "transitionPluginLifecycle",
    "bearer",
    async ({ auth, params, body }) => {
      // Mirror the conditional constraints published in PluginLifecycleRequest:
      // revocation must name its permission, and the global/admin kill-switch
      // form exists only for DISABLE. Validate before any installation lookup so
      // malformed contract shapes fail as BAD_REQUEST instead of being silently
      // narrowed to an installation-scoped action.
      if (
        body?.action === "REVOKE_PERMISSION" &&
        (typeof body?.permission !== "string" || body.permission.trim().length === 0)
      ) {
        throw new ContractError("BAD_REQUEST", "REVOKE_PERMISSION requires a permission field");
      }
      if (body?.scope !== undefined && body?.scope !== "installation" && body?.scope !== "global") {
        throw new ContractError("BAD_REQUEST", "lifecycle scope must be installation or global");
      }
      if (body?.admin_kill_switch !== undefined && typeof body?.admin_kill_switch !== "boolean") {
        throw new ContractError("BAD_REQUEST", "admin_kill_switch must be a boolean when supplied");
      }
      if (body?.scope === "global" && body?.action !== "DISABLE") {
        throw new ContractError("BAD_REQUEST", "scope=global is only valid for lifecycle action DISABLE");
      }
      if (body?.admin_kill_switch === true && body?.action !== "DISABLE") {
        throw new ContractError("BAD_REQUEST", "admin_kill_switch is only valid for lifecycle action DISABLE");
      }
      const wantsGlobalKillSwitch =
        body?.action === "DISABLE" &&
        (body?.scope === "global" || body?.admin_kill_switch === true);
      if (wantsGlobalKillSwitch) {
        if (!ctx.isAdminOrOperatorAuth?.(auth)) {
          throw new ContractError("FORBIDDEN", "Plugin global kill switch requires admin or operator role");
        }
        const killed = pluginBroker.adminDisablePlugin(params.pluginId, {
          actorUserId: auth.cloudUserId,
          reason: body?.reason || null
        });
        return { status: 200, code: "PLUGIN_LIFECYCLE_OK", data: killed };
      }
      const res = pluginBroker.transitionUserPlugin(auth.cloudUserId, params.pluginId, {
        action: body?.action,
        targetVersion: body?.target_version,
        permission: body?.permission,
        schoolId: body?.school_id,
        actorIsAdmin: Boolean(ctx.isAdminOrOperatorAuth?.(auth)),
        reason: body?.reason
      });
      return { status: 200, code: "PLUGIN_LIFECYCLE_OK", data: res };
    }
  ),

  route(
    "POST",
    "/api/v1/plugins/{pluginId}/commands/{commandId}/invoke",
    "invokePluginCommand",
    "bearer",
    async ({ auth, params, body }) => {
      const res = await pluginBroker.invokePluginCommand({
        userId: auth.cloudUserId,
        pluginId: params.pluginId,
        commandName: params.commandId,
        payload: body?.payload || body?.input || {},
        requestedOrigin: body?.requested_origin || null,
        schoolId: body?.school_id || null
      });
      return { status: 200, code: "PLUGIN_COMMAND_EXECUTED", data: res };
    }
  ),

  route("GET", "/api/v1/features", "listHostFeatures", "public", async () => {
    const loadedCount = referencePluginLoadStatus.filter((plugin) => plugin.status === "LOADED").length;
    const failedCount = referencePluginLoadStatus.filter((plugin) => plugin.status === "FAILED").length;
    return {
      status: 200,
      code: "FEATURES_OK",
      data: {
        host_api_version: 2,
        supported_plugin_schemas: ["dis-extension/v2", "dis-plugin/v2", "dis-campus-plugin/v1"],
        dual_engine_booking: ["LOCAL_DEVICE", "CLOUD_HOSTED", "MANUAL_REMINDER"],
        parcel_providers: parcelHub.listProviders(),
        reference_plugins: {
          status: failedCount === 0 ? "OK" : "DEGRADED",
          expected_count: referencePluginLoadStatus.length,
          loaded_count: loadedCount,
          failed_count: failedCount,
          plugins: referencePluginLoadStatus
        }
      }
    };
  })
  ];
}
