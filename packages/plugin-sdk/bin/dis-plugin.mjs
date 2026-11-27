#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validatePluginManifest,
  buildSignedPluginManifest,
  verifySignedPluginPackage,
  loadPluginDirectory,
  parsePluginManifestJson,
  assertSafeRelativeArtifactPath
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

function pluginKeyHome() {
  return path.resolve(process.env.DIS_PLUGIN_KEY_HOME || path.join(os.homedir(), ".dis-plugin", "keys"));
}

function safeKeyDirectoryName(pluginId) {
  return String(pluginId || "plugin").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function defaultPrivateKeyPath(pluginId) {
  return path.join(pluginKeyHome(), safeKeyDirectoryName(pluginId), "plugin-signing-private.key");
}

function writePrivateKeyAtomically(keyPath, privateKeyBase64) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(keyPath), 0o700);
  } catch {}
  fs.writeFileSync(keyPath, privateKeyBase64, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function writePluginGitignore(dir) {
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    [
      "# W6-01a/AC-24: signing private keys must never be committed with plugin sources.",
      "plugin-signing-private.key",
      "*.private.key",
      "*.secret.key",
      ""
    ].join("\n"),
    "utf8"
  );
}

try {
  if (subcommand === "init") {
    const dir = path.resolve(targetArg || "./my-dis-plugin");
    const pluginId = parseFlag("--id", "org.example.custom-plugin");
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    const entryJs = "// Hosts verify these bytes for integrity but never evaluate plugin artifact code.\n" +
      "export async function execute(ctx) {\n" +
      "  return { status: 'OK', plugin: '" + pluginId + "', payload: ctx.payload };\n" +
      "}\n";
    fs.writeFileSync(path.join(dir, "dist/index.mjs"), entryJs, "utf8");

    const { publicKeyBase64, privateKeyBase64 } = generateEd25519KeyPair();
    fs.writeFileSync(path.join(dir, "plugin-signing-public.key"), publicKeyBase64, "utf8");
    const privateKeyPath = parseFlag("--private-key-out", defaultPrivateKeyPath(pluginId));
    writePrivateKeyAtomically(privateKeyPath, privateKeyBase64);
    writePluginGitignore(dir);

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
            card_id: pluginId + ".card",
            title: "Custom Campus Service",
            subtitle: "Zero-Host-Change Extension",
            action_command: "ping"
          }
        ],
        commands: [
          {
            name: "ping",
            description: "Show signed plugin data without executing plugin code",
            required_permission: "ui.slot.render",
            type: "show_data",
            artifact_path: "dist/index.mjs"
          }
        ]
      },
      artifactMap: {
        "dist/index.mjs": Buffer.from(entryJs, "utf8")
      },
      privateKeyBase64
    });

    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(signed, null, 2), "utf8");
    console.log(JSON.stringify({
      ok: true,
      command: "init",
      dir,
      plugin_id: pluginId,
      public_key_path: path.join(dir, "plugin-signing-public.key"),
      private_key_path: privateKeyPath,
      gitignore_path: path.join(dir, ".gitignore")
    }));
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
    const raw = parsePluginManifestJson(fs.readFileSync(manifestPath, "utf8"));
    const privPath = path.resolve(parseFlag("--key", defaultPrivateKeyPath(raw.plugin_id)));
    const privateKeyBase64 = fs.readFileSync(privPath, "utf8").trim();

    const artifactMap = {};
    for (const art of raw.entry_artifacts || [{ path: "dist/index.mjs" }]) {
      // AC-24: sign applies the same traversal boundary as runtime verification.
      // In particular '../x' can never escape the plugin directory at signing time.
      const safePath = assertSafeRelativeArtifactPath(art.path);
      const full = path.join(dir, safePath);
      artifactMap[safePath] = fs.readFileSync(full);
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
