// W6-01b: dis-plugin CLI command implementations.
// bin/dis-plugin.mjs is a thin wrapper around runDisPluginCli so tests can
// drive every command in-process with captured output and controlled env.
//
// Commands:
//   keygen    create a publisher keypair in the keyring (never in the project)
//   init      scaffold a plugin from the card/service/datapack/legacy templates
//   validate  schema + semantic validation of a plugin directory or pack zip
//   sign      recompute artifact digests and Ed25519-sign the manifest
//   pack      produce a deterministic, verifiable plugin zip archive
//   verify    verify signature + digests of a directory or pack zip
//   simulate  offline simulated host: slots, descriptors, declarative commands
//   doctor    composite pre-publish diagnosis with stable check ids
//   package   alias of pack (since W6-01b; it was a placeholder alias of sign in W6-00)
//   test      alias of verify
import fs from "node:fs";
import path from "node:path";
import {
  validatePluginManifest,
  buildSignedPluginManifest,
  verifySignedPluginPackage,
  loadPluginDirectory,
  parsePluginManifestJson,
  assertSafeRelativeArtifactPath
} from "./index.mjs";
import { generateEd25519KeyPair, sha256Hex } from "../../crypto/src/index.mjs";
import {
  keygenPublisherKeypair,
  resolvePrivateKey,
  resolvePublicKey,
  derivePublicKeyBase64,
  readKeyringPrivateKey,
  LEGACY_PRIVATE_KEY_FILE,
  LEGACY_PUBLIC_KEY_FILE
} from "./keyring.mjs";
import { buildTemplateScaffold, PLUGIN_INIT_TEMPLATES, DEFAULT_INIT_TEMPLATE } from "./templates.mjs";
import {
  writePluginPackageZip,
  unpackPluginPackage,
  buildPackEntries,
  PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY
} from "./package-zip.mjs";
import { simulatePluginHost } from "./simulate-host.mjs";
import { diagnosePlugin } from "./doctor.mjs";

const GITIGNORE_LINES = [
  "# dis-plugin key hygiene: never commit publisher private keys",
  LEGACY_PRIVATE_KEY_FILE,
  "*.private.key",
  ""
].join("\n");

export const CLI_USAGE = [
  "Usage: dis-plugin <command> [dir|zip] [flags]",
  "",
  "  keygen [--id <plugin-id>] [--force]                 create keyring publisher keypair",
  "  init <dir> [--id <id>] [--template card|service|datapack|legacy] [--keyring]",
  "  validate [dir|zip]                                  schema + semantic validation",
  "  sign [dir] [--key <private-key-file>]               recompute digests and sign",
  "  pack [dir] [--out <file.zip>]                       build deterministic plugin zip",
  "  package                                             alias of pack",
  "  verify [dir|zip] [--pub <public-key-file>]          verify signature + digests",
  "  test                                                alias of verify",
  "  simulate [dir|zip] [--payload <json>] [--origin <https://..>] [--pretty]",
  "  doctor [dir|zip] [--pretty]                         composite pre-publish diagnosis",
  ""
].join("\n");

function parseFlags(argv) {
  const flags = new Map();
  const positional = [];
  const booleanFlags = new Set(["--force", "--keyring", "--pretty", "--help"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      if (booleanFlags.has(token)) {
        flags.set(token, true);
      } else if (i + 1 < argv.length) {
        flags.set(token, argv[i + 1]);
        i += 1;
      } else {
        flags.set(token, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function isZipTarget(targetPath) {
  if (String(targetPath).endsWith(".zip")) return true;
  try {
    return !fs.statSync(targetPath).isDirectory();
  } catch {
    return String(targetPath).endsWith(".zip");
  }
}

/**
 * Load a plugin either from a project directory or a pack zip.
 * Zip input is fully unpacked and digest-verified by unpackPluginPackage.
 */
export function loadPluginSource(targetPath) {
  const resolved = path.resolve(targetPath);
  if (isZipTarget(resolved)) {
    const archive = fs.readFileSync(resolved);
    const unpacked = unpackPluginPackage(archive);
    return {
      kind: "zip",
      pluginDir: null,
      zipPath: resolved,
      manifest: unpacked.manifest,
      artifactMap: unpacked.artifactMap,
      embeddedPublicKeyBase64: unpacked.publicKeyBase64
    };
  }
  const loaded = loadPluginDirectory(resolved);
  return {
    kind: "dir",
    pluginDir: resolved,
    zipPath: null,
    manifest: loaded.manifest,
    artifactMap: loaded.artifactMap,
    embeddedPublicKeyBase64: null
  };
}

function resolvePublicKeyForSource(source, explicitPub, env) {
  const direct = resolvePublicKey({
    pluginId: source.manifest?.plugin_id || null,
    explicitPath: explicitPub || null,
    pluginDir: source.pluginDir,
    env
  });
  if (direct) return direct;
  // Derivation fallback: a private key mathematically determines its public key.
  try {
    const priv = resolvePrivateKey({
      pluginId: source.manifest?.plugin_id || null,
      explicitPath: null,
      pluginDir: source.pluginDir,
      env
    });
    return { key: derivePublicKeyBase64(priv.key), source: "derived-from-private", key_path: priv.key_path };
  } catch {
    // fall through to the zip-embedded key
  }
  if (source.embeddedPublicKeyBase64) {
    return { key: source.embeddedPublicKeyBase64, source: "embedded-in-zip", key_path: null };
  }
  return null;
}

/**
 * Symlink-escape hardening (review 2026-11-27): sign/pack embed artifact bytes
 * verbatim into a signed, publishable package, so reading them must never
 * follow a symlink. A malicious plugin checkout can carry
 * assets/payload.json -> ../../../../etc/passwd; without this guard the file
 * outside the project would be signed and packed. Policy: every path component
 * below the plugin directory is lstat-checked and any symlink is rejected
 * outright (even one pointing back inside the project — archived bytes must be
 * the bytes in the project tree, not host-dependent), the final component must
 * be a regular file, and the canonical realpath must stay inside the canonical
 * plugin root as defense in depth.
 */
function readArtifactBytesSafely(pluginDir, safePath) {
  const full = path.join(pluginDir, safePath);
  const rel = path.relative(pluginDir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("artifact path escapes the plugin directory: " + safePath);
  }
  let cursor = pluginDir;
  const segments = safePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch {
      throw new Error("declared artifact missing on disk: " + safePath);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        "artifact path contains a symlink component (symlink-escape protection): " + safePath
      );
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error("artifact is not a regular file: " + safePath);
    }
  }
  const rootReal = fs.realpathSync(pluginDir);
  const fullReal = fs.realpathSync(full);
  if (fullReal !== rootReal && !fullReal.startsWith(rootReal + path.sep)) {
    throw new Error("artifact realpath escapes the plugin directory: " + safePath);
  }
  return fs.readFileSync(full);
}

function readArtifactsSafely(pluginDir, manifestDraft) {
  // S10 hardening: validate every declared artifact path BEFORE touching the
  // filesystem, so a malicious or broken manifest cannot make sign read
  // outside the plugin directory.
  const artifactMap = {};
  for (const art of manifestDraft.entry_artifacts || [{ path: "dist/index.mjs" }]) {
    const safePath = assertSafeRelativeArtifactPath(art.path);
    artifactMap[safePath] = readArtifactBytesSafely(pluginDir, safePath);
  }
  return artifactMap;
}

function commandKeygen({ flags, env }) {
  const pluginId = flags.get("--id") || "org.example.custom-plugin";
  const result = keygenPublisherKeypair({ pluginId, force: flags.get("--force") === true, env });
  return {
    ok: true,
    command: "keygen",
    plugin_id: result.plugin_id,
    keyring_dir: result.keyring_dir,
    public_key_path: result.public_key_path,
    private_key_path: result.private_key_path,
    public_key_base64: result.public_key_base64,
    note: "private key stays in the keyring with mode 0600; distribute only the public key"
  };
}

function commandInit({ positional, flags, env }) {
  const dir = path.resolve(positional[0] || "./my-dis-plugin");
  const pluginId = flags.get("--id") || "org.example.custom-plugin";
  const template = flags.get("--template") || DEFAULT_INIT_TEMPLATE;
  if (!PLUGIN_INIT_TEMPLATES.includes(template)) {
    throw new Error(
      "unknown template '" + template + "'; supported templates: " + PLUGIN_INIT_TEMPLATES.join(", ")
    );
  }
  const useKeyring = flags.get("--keyring") === true;

  const scaffold = buildTemplateScaffold(pluginId, template);
  fs.mkdirSync(dir, { recursive: true });
  const artifactEntries = [];
  for (const [artifactPath, content] of Object.entries(scaffold.artifacts)) {
    const safePath = assertSafeRelativeArtifactPath(artifactPath);
    const full = path.join(dir, safePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    artifactEntries.push([safePath, Buffer.from(content, "utf8")]);
  }

  const artifactMap = Object.fromEntries(artifactEntries);
  let keySource;
  let publicKeyBase64;
  let privateKeyBase64;

  if (useKeyring) {
    let keyringKey = readKeyringPrivateKey(pluginId, env);
    if (!keyringKey) {
      keygenPublisherKeypair({ pluginId, force: false, env });
      keyringKey = readKeyringPrivateKey(pluginId, env);
      keySource = "keyring-created";
    } else {
      keySource = "keyring-existing";
    }
    privateKeyBase64 = keyringKey;
    publicKeyBase64 = derivePublicKeyBase64(privateKeyBase64);
    // Only the public key enters the project; the private key never leaves the keyring.
    fs.writeFileSync(path.join(dir, LEGACY_PUBLIC_KEY_FILE), publicKeyBase64 + "\n", "utf8");
  } else {
    // Legacy compatibility mode (W6-00 behavior): the keypair is generated into
    // the project directory. W6-01a/AC-24 owns retiring this default; the
    // generated .gitignore at least keeps the key out of version control.
    const pair = generateEd25519KeyPair();
    privateKeyBase64 = pair.privateKeyBase64;
    publicKeyBase64 = pair.publicKeyBase64;
    keySource = "legacy-in-dir";
    fs.writeFileSync(path.join(dir, LEGACY_PUBLIC_KEY_FILE), publicKeyBase64, "utf8");
    fs.writeFileSync(path.join(dir, LEGACY_PRIVATE_KEY_FILE), privateKeyBase64, "utf8");
  }

  const signed = buildSignedPluginManifest({
    manifestDraft: scaffold.manifestDraft,
    artifactMap,
    privateKeyBase64
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(signed, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, ".gitignore"), GITIGNORE_LINES, "utf8");

  return {
    ok: true,
    command: "init",
    dir,
    plugin_id: pluginId,
    template,
    key_source: keySource,
    artifacts: Object.keys(scaffold.artifacts).sort()
  };
}

function commandValidate({ target }) {
  const source = loadPluginSource(target);
  const normalized = validatePluginManifest(source.manifest);
  return {
    ok: true,
    command: "validate",
    input_kind: source.kind,
    plugin_id: normalized.plugin_id,
    version: normalized.version
  };
}

function commandSign({ target, flags, env }) {
  const dir = path.resolve(target);
  const manifestPath = path.join(dir, "manifest.json");
  const raw = parsePluginManifestJson(fs.readFileSync(manifestPath, "utf8"));
  const priv = resolvePrivateKey({
    pluginId: raw.plugin_id || null,
    explicitPath: flags.get("--key") || null,
    pluginDir: dir,
    env
  });
  const artifactMap = readArtifactsSafely(dir, raw);
  const signed = buildSignedPluginManifest({
    manifestDraft: raw,
    artifactMap,
    privateKeyBase64: priv.key
  });
  fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2), "utf8");
  return {
    ok: true,
    command: "sign",
    plugin_id: signed.plugin_id,
    version: signed.version,
    key_source: priv.source,
    artifacts_signed: Object.keys(artifactMap).sort()
  };
}

function commandPack({ target, flags, env }) {
  const dir = path.resolve(target);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json not found in " + dir);
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = parsePluginManifestJson(manifestBytes.toString("utf8"));
  const normalized = validatePluginManifest(manifest);
  if (!normalized.signature) {
    throw new Error("pack requires a signed manifest; run dis-plugin sign first");
  }

  const artifactEntries = [];
  for (const declared of normalized.entry_artifacts || []) {
    const safePath = assertSafeRelativeArtifactPath(declared.path);
    // Same symlink-escape protection as sign: packed bytes must come from the
    // project tree itself, never from a symlink target outside it.
    artifactEntries.push([safePath, readArtifactBytesSafely(dir, safePath)]);
  }
  const artifactMap = Object.fromEntries(artifactEntries);

  const pub = resolvePublicKeyForSource(
    { manifest: normalized, pluginDir: dir, embeddedPublicKeyBase64: null },
    flags.get("--pub") || null,
    env
  );
  if (!pub) {
    throw new Error("pack requires a resolvable public key (--pub, keyring, or in-dir public key)");
  }
  // Pack never ships a package that fails verification: digest or signature
  // regressions are caught here rather than at install time.
  verifySignedPluginPackage({
    manifest: normalized,
    artifactMap,
    publicKeyBase64: pub.key
  });

  const entries = buildPackEntries({
    manifestBytes,
    artifactEntries,
    publicKeyBase64: pub.key
  });
  const zipBytes = writePluginPackageZip(entries);

  const defaultName = normalized.plugin_id + "-" + normalized.version + ".zip";
  const outPath = path.resolve(flags.get("--out") || path.join(dir, defaultName));
  fs.writeFileSync(outPath, zipBytes);

  return {
    ok: true,
    command: "pack",
    plugin_id: normalized.plugin_id,
    version: normalized.version,
    zip_path: outPath,
    zip_sha256: sha256Hex(zipBytes),
    size_bytes: zipBytes.length,
    entries: entries.map(([entryPath]) => entryPath).sort(),
    public_key_entry: PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY,
    key_source: pub.source
  };
}

function commandVerify({ target, flags, env }) {
  const source = loadPluginSource(target);
  const pub = resolvePublicKeyForSource(source, flags.get("--pub") || null, env);
  if (!pub) {
    throw new Error("no public key resolvable for verification (--pub, keyring, in-dir, or zip-embedded)");
  }
  const verified = verifySignedPluginPackage({
    manifest: source.manifest,
    artifactMap: source.artifactMap,
    publicKeyBase64: pub.key
  });
  return {
    ok: true,
    command: "verify",
    input_kind: source.kind,
    plugin_id: verified.plugin_id,
    version: verified.version,
    verified_artifacts: verified.entry_artifacts.length,
    key_source: pub.source
  };
}

async function commandSimulate({ target, flags, env }) {
  const source = loadPluginSource(target);
  const pub = resolvePublicKeyForSource(source, flags.get("--pub") || null, env);
  if (!pub) {
    throw new Error("no public key resolvable for simulation (--pub, keyring, in-dir, or zip-embedded)");
  }
  let payload = null;
  if (flags.get("--payload")) {
    try {
      payload = JSON.parse(flags.get("--payload"));
    } catch (error) {
      throw new Error("--payload must be valid JSON: " + (error?.message || String(error)));
    }
  }
  const report = await simulatePluginHost({
    manifest: source.manifest,
    artifactMap: source.artifactMap,
    publicKeyBase64: pub.key,
    payload,
    requestedOrigin: flags.get("--origin") || null
  });
  return {
    ok: true,
    command: "simulate",
    input_kind: source.kind,
    key_source: pub.source,
    ...report
  };
}

function commandDoctor({ target, flags, env }) {
  let source;
  let manifest = null;
  let manifestError = null;
  try {
    source = loadPluginSource(target);
    manifest = source.manifest;
  } catch (error) {
    // Even a broken project deserves a diagnosis: report the parse/structure
    // failure instead of crashing the doctor itself.
    const resolved = path.resolve(target);
    source = {
      kind: "dir",
      pluginDir:
        fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null,
      artifactMap: {},
      embeddedPublicKeyBase64: null
    };
    manifestError = error?.message || String(error);
    if (error?.detail?.runtime_validation_code) {
      manifestError += " [" + error.detail.runtime_validation_code + "]";
    }
  }
  const pub = manifest ? resolvePublicKeyForSource(source, flags.get("--pub") || null, env) : null;
  const report = diagnosePlugin({
    manifest,
    manifestError,
    artifactMap: source.artifactMap,
    pluginDir: source.pluginDir,
    publicKeyBase64: pub?.key || null,
    publicKeySource: pub?.source || null
  });
  return {
    ok: report.ok,
    command: "doctor",
    input_kind: source.kind,
    ...report
  };
}

/**
 * Run the CLI. Returns the process exit code; output is emitted through io.
 */
export async function runDisPluginCli(argv, io = {}) {
  const stdout = io.stdout || ((line) => console.log(line));
  const stderr = io.stderr || ((line) => console.error(line));
  const env = io.env || process.env;

  const [subcommand, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const pretty = flags.get("--pretty") === true;
  const emit = (obj) => stdout(JSON.stringify(obj, null, pretty ? 2 : 0));

  try {
    let result;
    switch (subcommand) {
      case "keygen":
        result = commandKeygen({ flags, env });
        break;
      case "init":
        result = commandInit({ positional, flags, env });
        break;
      case "validate":
        result = commandValidate({ target: positional[0] || "." });
        break;
      case "sign":
        result = commandSign({ target: positional[0] || ".", flags, env });
        break;
      case "pack":
      case "package":
        result = commandPack({ target: positional[0] || ".", flags, env });
        break;
      case "verify":
      case "test":
        result = commandVerify({ target: positional[0] || ".", flags, env });
        break;
      case "simulate":
        result = await commandSimulate({ target: positional[0] || ".", flags, env });
        break;
      case "doctor":
        result = commandDoctor({ target: positional[0] || ".", flags, env });
        break;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        stdout(CLI_USAGE);
        return subcommand === undefined ? 1 : 0;
      default:
        stderr(CLI_USAGE);
        stderr(JSON.stringify({ ok: false, error: "unknown command: " + subcommand, code: "CLI_USAGE" }));
        return 1;
    }

    emit(result);
    // doctor reports failures in-band; every other command throws on failure.
    if (subcommand === "doctor" && result.ok === false) {
      return 1;
    }
    return 0;
  } catch (error) {
    const detail = {
      ok: false,
      command: subcommand || null,
      error: error?.message || String(error),
      code: error?.code || "CLI_ERROR"
    };
    if (error?.detail?.runtime_validation_code) {
      detail.runtime_validation_code = error.detail.runtime_validation_code;
    }
    stderr(JSON.stringify(detail));
    return 1;
  }
}
