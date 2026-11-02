#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  validatePluginManifest,
  buildSignedPluginManifest,
  verifySignedPluginPackage,
  loadPluginDirectory
} from "../src/index.mjs";
import { generateEd25519KeyPair } from "../../crypto/src/index.mjs";

const [, , subcommand, targetArg, ...flags] = process.argv;

function parseFlag(name, defaultValue = null) {
  const idx = flags.indexOf(name);
  if (idx >= 0 && idx + 1 < flags.length) {
    return flags[idx + 1];
  }
  return defaultValue;
}

try {
  if (subcommand === "init") {
    const dir = path.resolve(targetArg || "./my-dis-plugin");
    const pluginId = parseFlag("--id", "org.example.custom-plugin");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    const entryJs = `export async function execute(ctx) {\n  return { status: 'OK', plugin: '${pluginId}', payload: ctx.payload };\n}\n`;
    fs.writeFileSync(path.join(dir, "dist/index.mjs"), entryJs, "utf8");

    const { publicKeyBase64, privateKeyBase64 } = generateEd25519KeyPair();
    fs.writeFileSync(path.join(dir, "plugin-signing-public.key"), publicKeyBase64, "utf8");
    fs.writeFileSync(path.join(dir, "plugin-signing-private.key"), privateKeyBase64, "utf8");

    const signed = buildSignedPluginManifest({
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
            card_id: `${pluginId}.card`,
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
      artifactMap: {
        "dist/index.mjs": Buffer.from(entryJs, "utf8")
      },
      privateKeyBase64
    });

    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(signed, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, command: "init", dir, plugin_id: pluginId }));
  } else if (subcommand === "validate") {
    const dir = path.resolve(targetArg || ".");
    const { manifest } = loadPluginDirectory(dir);
    const normalized = validatePluginManifest(manifest);
    console.log(
      JSON.stringify({
        ok: true,
        command: "validate",
        plugin_id: normalized.plugin_id,
        version: normalized.version
      })
    );
  } else if (subcommand === "sign" || subcommand === "package") {
    const dir = path.resolve(targetArg || ".");
    const manifestPath = path.join(dir, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const privPath = parseFlag("--key", path.join(dir, "plugin-signing-private.key"));
    const privateKeyBase64 = fs.readFileSync(privPath, "utf8").trim();

    const artifactMap = {};
    for (const art of raw.entry_artifacts || [{ path: "dist/index.mjs" }]) {
      const full = path.join(dir, art.path);
      artifactMap[art.path] = fs.readFileSync(full);
    }

    const signed = buildSignedPluginManifest({
      manifestDraft: raw,
      artifactMap,
      privateKeyBase64
    });
    fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2), "utf8");
    console.log(
      JSON.stringify({
        ok: true,
        command: subcommand,
        plugin_id: signed.plugin_id,
        version: signed.version
      })
    );
  } else if (subcommand === "verify" || subcommand === "test") {
    const dir = path.resolve(targetArg || ".");
    const { manifest, artifactMap } = loadPluginDirectory(dir);
    const pubPath = parseFlag("--pub", path.join(dir, "plugin-signing-public.key"));
    const publicKeyBase64 = fs.readFileSync(pubPath, "utf8").trim();
    const verified = verifySignedPluginPackage({
      manifest,
      artifactMap,
      publicKeyBase64
    });
    console.log(
      JSON.stringify({
        ok: true,
        command: subcommand,
        plugin_id: verified.plugin_id,
        version: verified.version,
        verified_artifacts: verified.entry_artifacts.length
      })
    );
  } else {
    console.error("Usage: dis-plugin <init|validate|package|sign|verify|test> [dir]");
    process.exit(1);
  }
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err.message, code: err.code || "CLI_ERROR" }));
  process.exit(1);
}
