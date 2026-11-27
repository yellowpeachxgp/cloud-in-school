// W6-01b: offline simulated host for dis-extension/v2 plugins.
//
// The simulator reuses the real runtime broker (PluginRegistryAndBroker) in
// memory, so what a developer sees locally is exactly what the current cloud
// host would resolve: the same descriptor assembly, the same permission gate,
// the same declarative command semantics. It performs no network access and
// never evaluates artifact code. Mock school data embedded in the invocation
// payload is labeled SIMULATED and exists so declarative commands have honest
// example input; it is not real school data.
import {
  PluginRegistryAndBroker,
  verifySignedPluginPackage
} from "./index.mjs";
import { RUNTIME_UI_SLOTS } from "./runtime-contract.mjs";

export const SIMULATE_USER_ID = "simulate-user";

export function simulateMockSchoolContext(nowIso = new Date().toISOString()) {
  return {
    data_provenance: "SIMULATED_HOST_MOCK",
    school_id: "haut",
    school_name: "模拟大学（示例数据，非真实学校）",
    campus: "模拟校区",
    term_id: "2026-2027-1",
    teaching_week: 8,
    timezone: "Asia/Shanghai",
    simulated_at: nowIso
  };
}

/**
 * Run the offline host simulation for one verified plugin package.
 *
 * @param {object} options
 * @param {object} options.manifest normalized+signed manifest
 * @param {object} options.artifactMap artifact path -> Buffer
 * @param {string} options.publicKeyBase64 publisher public key used for verification
 * @param {object|string|null} options.payload command payload override (default: mock school context)
 * @param {string|null} options.requestedOrigin simulated outbound origin probe
 * @param {number} options.hostApiVersion simulated host API level
 */
export async function simulatePluginHost({
  manifest,
  artifactMap = {},
  publicKeyBase64,
  payload = null,
  requestedOrigin = null,
  hostApiVersion = 2
}) {
  const verified = verifySignedPluginPackage({
    manifest,
    artifactMap,
    publicKeyBase64,
    hostApiVersion
  });

  const broker = new PluginRegistryAndBroker({ hostApiVersion });
  broker.registerPluginPackage({
    manifest,
    artifactMap,
    publicKeyBase64
  });
  const installation = broker.installPluginForUser(SIMULATE_USER_ID, verified.plugin_id, {
    version: verified.version
  });

  const slots = {};
  for (const slotId of RUNTIME_UI_SLOTS) {
    slots[slotId] = broker.getResolvedUiSlotDescriptors(SIMULATE_USER_ID, slotId);
  }

  const mockContext = simulateMockSchoolContext();
  const effectivePayload = payload ?? { mock_school_context: mockContext };
  const commands = [];
  for (const command of verified.commands || []) {
    const record = {
      name: command.name,
      required_permission: command.required_permission || null,
      granted:
        !command.required_permission ||
        (installation.granted_permissions || []).includes(command.required_permission)
    };
    try {
      const result = await broker.invokePluginCommand({
        userId: SIMULATE_USER_ID,
        pluginId: verified.plugin_id,
        commandName: command.name,
        payload: effectivePayload,
        requestedOrigin
      });
      record.executed = result.executed;
      record.output = result.output;
    } catch (error) {
      record.executed = false;
      record.error = error?.message || String(error);
      record.error_code = error?.code || "SIMULATE_COMMAND_ERROR";
    }
    commands.push(record);
  }

  return {
    plugin_id: verified.plugin_id,
    version: verified.version,
    host_api: hostApiVersion,
    user: SIMULATE_USER_ID,
    installation: {
      status: installation.status,
      active_version: installation.active_version,
      granted_permissions: installation.granted_permissions
    },
    slots,
    commands,
    mock_school_context: mockContext,
    notes: [
      "Simulation uses the real runtime broker in memory; descriptors and permission gates match host behavior.",
      "Declarative commands currently produce the broker echo response; artifact code is never executed.",
      "mock_school_context is simulated example data, not real school data."
    ]
  };
}
