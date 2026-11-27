// W6-01b: publisher keyring management for the dis-plugin CLI.
//
// The keyring keeps Ed25519 publisher keypairs OUTSIDE the plugin project
// directory so a project can be committed or published without leaking the
// private key. Location resolution order:
//   1. $DIS_PLUGIN_HOME/keys when the environment variable is set (tests, CI)
//   2. ~/.dis-plugin/keys otherwise
// Legacy in-directory keys (plugin-signing-private.key next to manifest.json)
// remain readable as a compatibility fallback; W6-01a/AC-24 owns the final
// migration of "init" away from in-directory key generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContractError } from "../../contracts/src/index.mjs";
import crypto from "node:crypto";
import { generateEd25519KeyPair } from "../../crypto/src/index.mjs";

/** Derive the SPKI-DER base64 public key for a PKCS8-DER base64 private key. */
export function derivePublicKeyBase64(privateKeyBase64) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8"
  });
  return crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

export const KEYRING_PRIVATE_KEY_SUFFIX = ".private.key";
export const KEYRING_PUBLIC_KEY_SUFFIX = ".public.key";
export const LEGACY_PRIVATE_KEY_FILE = "plugin-signing-private.key";
export const LEGACY_PUBLIC_KEY_FILE = "plugin-signing-public.key";

export function keyringDir(env = process.env) {
  const override = env?.DIS_PLUGIN_HOME;
  if (override && override.trim()) {
    return path.join(override, "keys");
  }
  return path.join(os.homedir(), ".dis-plugin", "keys");
}

function assertKeyringPluginId(pluginId) {
  if (typeof pluginId !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(pluginId)) {
    throw new ContractError(
      "BAD_REQUEST",
      "keyring entries require a valid dotted plugin id (a-z0-9 segments)",
      { plugin_id: pluginId }
    );
  }
  return pluginId;
}

export function keyringPrivateKeyPath(pluginId, env = process.env) {
  return path.join(keyringDir(env), assertKeyringPluginId(pluginId) + KEYRING_PRIVATE_KEY_SUFFIX);
}

export function keyringPublicKeyPath(pluginId, env = process.env) {
  return path.join(keyringDir(env), assertKeyringPluginId(pluginId) + KEYRING_PUBLIC_KEY_SUFFIX);
}

/**
 * Generate a fresh Ed25519 publisher keypair into the keyring.
 * Refuses to overwrite an existing keypair unless force is set; a silent
 * overwrite would invalidate every package ever signed with the old key.
 */
export function keygenPublisherKeypair({ pluginId, force = false, env = process.env }) {
  const privatePath = keyringPrivateKeyPath(pluginId, env);
  const publicPath = keyringPublicKeyPath(pluginId, env);
  if (!force && (fs.existsSync(privatePath) || fs.existsSync(publicPath))) {
    throw new ContractError(
      "BAD_REQUEST",
      "keyring already contains a keypair for this plugin id; pass --force to rotate it deliberately",
      { plugin_id: pluginId, keyring_private_path: privatePath }
    );
  }
  const pair = generateEd25519KeyPair();
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, pair.privateKeyBase64 + "\n", { encoding: "utf8", mode: 0o600 });
  // writeFileSync's mode only applies when the file is first created; a --force
  // rotation overwrites the existing inode and would silently keep whatever
  // permissive bits the old file had. chmod unconditionally so the private key
  // is owner-only after every rotation, not just after initial creation.
  fs.chmodSync(privatePath, 0o600);
  fs.writeFileSync(publicPath, pair.publicKeyBase64 + "\n", { encoding: "utf8", mode: 0o644 });
  return {
    plugin_id: pluginId,
    keyring_dir: keyringDir(env),
    private_key_path: privatePath,
    public_key_path: publicPath,
    public_key_base64: pair.publicKeyBase64
  };
}

export function readKeyringPrivateKey(pluginId, env = process.env) {
  const privatePath = keyringPrivateKeyPath(pluginId, env);
  if (!fs.existsSync(privatePath)) return null;
  return fs.readFileSync(privatePath, "utf8").trim();
}

export function readKeyringPublicKey(pluginId, env = process.env) {
  const publicPath = keyringPublicKeyPath(pluginId, env);
  if (!fs.existsSync(publicPath)) return null;
  return fs.readFileSync(publicPath, "utf8").trim();
}

/**
 * Private key resolution order for signing commands:
 *   1. explicit --key path
 *   2. keyring entry for the plugin id
 *   3. legacy in-directory plugin-signing-private.key (compatibility only)
 */
export function resolvePrivateKey({ pluginId, explicitPath = null, pluginDir = null, env = process.env }) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new ContractError("BAD_REQUEST", "explicit private key file does not exist", {
        key_path: resolved
      });
    }
    return { key: fs.readFileSync(resolved, "utf8").trim(), source: "explicit", key_path: resolved };
  }
  if (pluginId) {
    const keyringKey = readKeyringPrivateKey(pluginId, env);
    if (keyringKey) {
      return { key: keyringKey, source: "keyring", key_path: keyringPrivateKeyPath(pluginId, env) };
    }
  }
  if (pluginDir) {
    const legacyPath = path.join(pluginDir, LEGACY_PRIVATE_KEY_FILE);
    if (fs.existsSync(legacyPath)) {
      return { key: fs.readFileSync(legacyPath, "utf8").trim(), source: "legacy-in-dir", key_path: legacyPath };
    }
  }
  throw new ContractError(
    "BAD_REQUEST",
    "no private key found: pass --key, create a keyring entry with keygen, or keep a legacy in-directory key",
    { plugin_id: pluginId || null }
  );
}

/**
 * Public key resolution order for verification commands:
 *   1. explicit --pub path
 *   2. keyring entry for the plugin id
 *   3. legacy in-directory plugin-signing-public.key
 *   4. public key embedded in a pack zip (handled by the caller)
 */
export function resolvePublicKey({ pluginId, explicitPath = null, pluginDir = null, env = process.env }) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new ContractError("BAD_REQUEST", "explicit public key file does not exist", {
        key_path: resolved
      });
    }
    return { key: fs.readFileSync(resolved, "utf8").trim(), source: "explicit", key_path: resolved };
  }
  if (pluginId) {
    const keyringKey = readKeyringPublicKey(pluginId, env);
    if (keyringKey) {
      return { key: keyringKey, source: "keyring", key_path: keyringPublicKeyPath(pluginId, env) };
    }
  }
  if (pluginDir) {
    const legacyPath = path.join(pluginDir, LEGACY_PUBLIC_KEY_FILE);
    if (fs.existsSync(legacyPath)) {
      return { key: fs.readFileSync(legacyPath, "utf8").trim(), source: "legacy-in-dir", key_path: legacyPath };
    }
  }
  return null;
}
