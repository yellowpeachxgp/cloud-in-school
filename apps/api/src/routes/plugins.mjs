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
    if (body?.manifest) {
      const canOverridePublicKey =
        Array.isArray(auth?.roles) &&
        (auth.roles.includes("PLATFORM_OWNER") || auth.roles.includes("ADMIN"));
      if (
        body.public_key_base64 &&
        body.public_key_base64 !== pluginBroker.publicKeyBase64 &&
        process.env.NODE_ENV === "production" &&
        !canOverridePublicKey
      ) {
        throw new ContractError(
          "FORBIDDEN",
          "Custom plugin public_key_base64 registration in production requires PLATFORM_OWNER or ADMIN role"
        );
      }
      pluginBroker.registerPluginPackage({
        manifest: body.manifest,
        artifactMap: body.artifact_map || {},
        publicKeyBase64: body.public_key_base64 || pluginBroker.publicKeyBase64,
        actorUserId: auth.cloudUserId,
        isAdmin: canOverridePublicKey
      });
    }
    const pluginId = body?.plugin_id || body?.manifest?.plugin_id;
    const inst = pluginBroker.installPluginForUser(auth.cloudUserId, pluginId, {
      version: body?.version || body?.manifest?.version
    });
    return { status: 201, code: "PLUGIN_INSTALLED", data: inst };
  }),

  route(
    "POST",
    "/api/v1/plugins/{pluginId}/lifecycle",
    "transitionPluginLifecycle",
    "bearer",
    async ({ auth, params, body }) => {
      const res = pluginBroker.transitionUserPlugin(auth.cloudUserId, params.pluginId, {
        action: body?.action,
        targetVersion: body?.target_version
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
        payload: body?.payload || {},
        requestedOrigin: body?.requested_origin || null
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
