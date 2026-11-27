// W6-01b: init templates for dis-extension/v2 plugin scaffolding.
//
// Three first-class templates plus the unchanged legacy default:
//   card     — a declarative home.cards card whose content ships as signed data
//   service  — a campus.services service entry pointing at an HTTPS service page
//   datapack — a signed data pack (dataset artifact) queried through a command
//   legacy   — the original W6-00 scaffold (campus.services + ping), kept so the
//              zero-host-change contract tests observe no behavior drift
//
// Every template stays inside the only supported extension form: declarative
// cards + declarative commands + signed data. Artifact JavaScript is integrity
// evidence only; hosts never evaluate it (SYSTEM_CONTRACT I.6).
export const PLUGIN_INIT_TEMPLATES = Object.freeze(["card", "service", "datapack", "legacy"]);
export const DEFAULT_INIT_TEMPLATE = "legacy";

const NON_EXECUTION_ARTIFACT_HEADER =
  "// Reference artifact bytes. The host verifies integrity only; it never evaluates plugin artifact code.\n" +
  "// Declarative card/command/data behavior is resolved by the host from manifest.json, not from this file.\n";

function entryArtifactSource(pluginId, templateNote) {
  return (
    NON_EXECUTION_ARTIFACT_HEADER +
    "export async function execute(ctx) {\n" +
    "  // Hosts must not call this. It documents the artifact shape only.\n" +
    "  return { status: 'OK', plugin: '" + pluginId + "', template: '" + templateNote + "', payload: ctx?.payload ?? null };\n" +
    "}\n"
  );
}

function cardTemplate(pluginId) {
  const cardData = {
    data_provenance: "SIMULATED_TEMPLATE_DATA",
    notice: "Sample signed card content. Replace with your own declarative data; keep sources honest.",
    card: {
      headline: "自习室空位速览",
      lines: [
        { label: "图书馆三楼", value: "空位 42" },
        { label: "8 号楼自习区", value: "空位 7" }
      ],
      refreshed_at: "2026-11-27T08:00:00+08:00"
    }
  };
  return {
    manifestDraft: {
      schema_version: "dis-extension/v2",
      plugin_id: pluginId,
      name: "Campus Card Plugin",
      version: "1.0.0",
      min_host_api: 2,
      max_host_api: 2,
      permissions: ["ui.slot.render"],
      allowed_origins: [],
      ui_slots: [
        {
          slot_id: "home.cards",
          card_id: pluginId + ".card",
          title: "校园卡片",
          subtitle: "declarative home card",
          action_command: "showCardData"
        }
      ],
      commands: [
        {
          name: "showCardData",
          description: "Show the signed card data shipped with this plugin",
          required_permission: "ui.slot.render"
        }
      ]
    },
    artifacts: {
      "dist/index.mjs": entryArtifactSource(pluginId, "card"),
      "assets/card-data.json": JSON.stringify(cardData, null, 2) + "\n"
    }
  };
}

function serviceTemplate(pluginId) {
  return {
    manifestDraft: {
      schema_version: "dis-extension/v2",
      plugin_id: pluginId,
      name: "Campus Service Entry Plugin",
      version: "1.0.0",
      min_host_api: 2,
      max_host_api: 2,
      permissions: ["ui.slot.render"],
      allowed_origins: ["https://service.example.com"],
      ui_slots: [
        {
          slot_id: "campus.services",
          card_id: pluginId + ".service",
          title: "校园服务入口",
          subtitle: "declarative service entry",
          action_command: "openService"
        }
      ],
      commands: [
        {
          name: "openService",
          description: "Open the declared HTTPS service page (declarative navigation, host-rendered)",
          required_permission: "ui.slot.render"
        }
      ]
    },
    artifacts: {
      "dist/index.mjs": entryArtifactSource(pluginId, "service")
    }
  };
}

function datapackTemplate(pluginId) {
  const dataset = {
    data_provenance: "SIMULATED_TEMPLATE_DATA",
    schema: "example-campus-services/v1",
    notice: "Sample signed dataset. Real data packs must cite sources and verification state per entry.",
    entries: [
      {
        id: "svc-library-seat",
        name: "图书馆座位预约",
        campus: "莲花街校区",
        building: "图书馆",
        hours: "07:30-22:00",
        sources: ["https://example.edu.cn/library"],
        verifiedAt: null,
        verification: "UNVERIFIED"
      },
      {
        id: "svc-repair-club",
        name: "计算机服务社维修",
        campus: "莲花街校区",
        building: "F01 W111",
        hours: "周六 14:00-18:00",
        sources: ["https://example.edu.cn/club"],
        verifiedAt: null,
        verification: "UNVERIFIED"
      }
    ]
  };
  return {
    manifestDraft: {
      schema_version: "dis-extension/v2",
      plugin_id: pluginId,
      name: "Campus Data Pack Plugin",
      version: "1.0.0",
      min_host_api: 2,
      max_host_api: 2,
      permissions: ["ui.slot.render"],
      allowed_origins: [],
      ui_slots: [
        {
          slot_id: "campus.services",
          card_id: pluginId + ".datapack",
          title: "校园数据包",
          subtitle: "signed dataset",
          action_command: "queryDataset"
        }
      ],
      commands: [
        {
          name: "queryDataset",
          description: "Query the signed dataset shipped inside this plugin package",
          required_permission: "ui.slot.render"
        }
      ]
    },
    artifacts: {
      "dist/index.mjs": entryArtifactSource(pluginId, "datapack"),
      "assets/dataset.json": JSON.stringify(dataset, null, 2) + "\n"
    }
  };
}

function legacyTemplate(pluginId) {
  return {
    manifestDraft: {
      schema_version: "dis-extension/v2",
      plugin_id: pluginId,
      name: "Custom Campus Extension",
      version: "1.0.0",
      min_host_api: 2,
      max_host_api: 2,
      permissions: ["ui.slot.render", "storage.scoped"],
      allowed_origins: [],
      ui_slots: [
        {
          slot_id: "campus.services",
          card_id: pluginId + ".card",
          title: "Custom Campus Service",
          subtitle: "Zero-Host-Change Extension",
          action_command: "ping"
        }
      ],
      commands: [
        {
          name: "ping",
          description: "Ping custom plugin",
          required_permission: "ui.slot.render"
        }
      ]
    },
    artifacts: {
      "dist/index.mjs":
        "export async function execute(ctx) {\n" +
        "  return { status: 'OK', plugin: '" + pluginId + "', payload: ctx.payload };\n" +
        "}\n"
    }
  };
}

export function buildTemplateScaffold(pluginId, template = DEFAULT_INIT_TEMPLATE) {
  switch (template) {
    case "card":
      return cardTemplate(pluginId);
    case "service":
      return serviceTemplate(pluginId);
    case "datapack":
      return datapackTemplate(pluginId);
    case "legacy":
      return legacyTemplate(pluginId);
    default:
      throw new Error(
        "Unknown init template '" + template + "'. Supported templates: " + PLUGIN_INIT_TEMPLATES.join(", ")
      );
  }
}
