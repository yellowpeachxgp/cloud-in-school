// W6-01b: dis-plugin doctor — composite diagnostic for plugin projects and packs.
// Runs every check a developer needs before publishing: schema, semantics,
// host compatibility, artifacts, signature, key hygiene, pack readiness.
// Every check reports PASS / WARN / FAIL / SKIP with a stable check id so the
// output can be diffed in CI. Exit-code policy lives in the CLI layer:
// any FAIL makes the command exit non-zero; WARN never does.
import fs from "node:fs";
import path from "node:path";
import {
  assertSafeRelativeArtifactPath,
  validatePluginManifest,
  verifySignedPluginPackage
} from "./index.mjs";
import {
  runtimeHostApiEntry,
  validatePluginRuntimeSchema
} from "./runtime-contract.mjs";
import { sha256Hex } from "../../crypto/src/index.mjs";
import { LEGACY_PRIVATE_KEY_FILE } from "./keyring.mjs";

function pass(id, message, detail = {}) {
  return { id, status: "PASS", message, ...detail };
}
function warn(id, message, detail = {}) {
  return { id, status: "WARN", message, ...detail };
}
function fail(id, message, detail = {}) {
  return { id, status: "FAIL", message, ...detail };
}
function skip(id, message, detail = {}) {
  return { id, status: "SKIP", message, ...detail };
}

/**
 * Diagnose a plugin loaded either from a directory or from a pack zip.
 *
 * @param {object} options
 * @param {object|null} options.manifest raw parsed manifest (null when unparseable)
 * @param {string|null} options.manifestError parse error message when unparseable
 * @param {object} options.artifactMap path -> Buffer content actually available
 * @param {string|null} options.pluginDir directory context (null for zip input)
 * @param {string|null} options.publicKeyBase64 resolved public key, when available
 * @param {string|null} options.publicKeySource key resolution source label
 * @param {number} options.hostApiVersion host API to check compatibility against
 */
export function diagnosePlugin({
  manifest,
  manifestError = null,
  artifactMap = {},
  pluginDir = null,
  publicKeyBase64 = null,
  publicKeySource = null,
  hostApiVersion = 2
}) {
  const checks = [];

  // 1. parse
  if (!manifest) {
    checks.push(
      fail("manifest.parse", "manifest.json cannot be parsed as strict plugin JSON", {
        error: manifestError || "unparseable"
      })
    );
    return finish(checks);
  }
  checks.push(pass("manifest.parse", "manifest.json parses under strict lexical rules"));

  // 2. schema (full issue list, not just the first failure)
  const schemaIssues = validatePluginRuntimeSchema(manifest);
  if (schemaIssues.length === 0) {
    checks.push(pass("manifest.schema", "runtime schema validation passes with zero issues"));
  } else {
    checks.push(
      fail("manifest.schema", "runtime schema validation reports " + schemaIssues.length + " issue(s)", {
        issues: schemaIssues.slice(0, 20),
        issue_count: schemaIssues.length
      })
    );
  }

  // 3. semantics (permissions catalog, slots, host range, digests format, paths)
  let normalized = null;
  try {
    normalized = validatePluginManifest(manifest, { hostApiVersion });
    checks.push(pass("manifest.semantics", "semantic validation passes (permissions, slots, paths, digests)"));
  } catch (error) {
    checks.push(
      fail("manifest.semantics", error?.message || String(error), {
        code: error?.code || "BAD_REQUEST",
        runtime_validation_code: error?.detail?.runtime_validation_code || null
      })
    );
  }

  // 4. host compatibility against the runtime matrix
  const hostEntry = runtimeHostApiEntry(hostApiVersion);
  if (!hostEntry) {
    checks.push(fail("host_api.compatibility", "host API " + hostApiVersion + " is absent from the runtime matrix"));
  } else if (
    normalized &&
    normalized.min_host_api <= hostApiVersion &&
    normalized.max_host_api >= hostApiVersion
  ) {
    checks.push(
      pass("host_api.compatibility", "host API " + hostApiVersion + " is inside the declared range", {
        format: hostEntry.format,
        slots: hostEntry.supported_ui_slots.length
      })
    );
  } else if (normalized) {
    checks.push(
      fail("host_api.compatibility", "declared host range excludes host API " + hostApiVersion, {
        min_host_api: normalized.min_host_api,
        max_host_api: normalized.max_host_api
      })
    );
  } else {
    checks.push(skip("host_api.compatibility", "skipped because semantic validation failed"));
  }

  // 5/6. artifacts present + digests
  if (normalized) {
    const missing = [];
    const sizeMismatch = [];
    const digestMismatch = [];
    for (const declared of normalized.entry_artifacts || []) {
      let safePath = declared.path;
      try {
        safePath = assertSafeRelativeArtifactPath(declared.path);
      } catch {
        // path safety already reported by semantic validation
      }
      const content = artifactMap[safePath];
      if (content === undefined) {
        missing.push(safePath);
        continue;
      }
      if (content.length !== declared.size_bytes) {
        sizeMismatch.push({ artifact_path: safePath, declared: declared.size_bytes, actual: content.length });
      }
      if (sha256Hex(content) !== declared.sha256) {
        digestMismatch.push(safePath);
      }
    }
    if ((normalized.entry_artifacts || []).length === 0) {
      checks.push(warn("artifacts.present", "manifest declares zero entry artifacts"));
    } else if (missing.length === 0) {
      checks.push(pass("artifacts.present", "all declared artifacts are available"));
    } else {
      checks.push(
        fail("artifacts.present", "declared artifacts are missing", { missing })
      );
    }
    if (missing.length === 0 && sizeMismatch.length === 0 && digestMismatch.length === 0) {
      checks.push(pass("artifacts.digest", "artifact sizes and SHA-256 digests match the manifest"));
    } else if (missing.length > 0) {
      checks.push(skip("artifacts.digest", "skipped because artifacts are missing"));
    } else {
      checks.push(
        fail("artifacts.digest", "artifact size or digest mismatch", {
          size_mismatch: sizeMismatch,
          digest_mismatch: digestMismatch
        })
      );
    }
  } else {
    checks.push(skip("artifacts.present", "skipped because semantic validation failed"));
    checks.push(skip("artifacts.digest", "skipped because semantic validation failed"));
  }

  // 7/8. signature
  if (!manifest.signature) {
    checks.push(
      fail("signature.structure", "manifest is unsigned; sign it before packing or publishing", {
        hint: "dis-plugin sign"
      })
    );
    checks.push(skip("signature.verify", "skipped because the manifest is unsigned"));
  } else if (!publicKeyBase64) {
    checks.push(pass("signature.structure", "signature object is present"));
    checks.push(
      warn("signature.verify", "no public key resolvable; cryptographic verification not performed", {
        hint: "pass --pub, use keygen, or ship plugin-signing-public.key"
      })
    );
  } else if (normalized) {
    try {
      verifySignedPluginPackage({ manifest, artifactMap, publicKeyBase64, hostApiVersion });
      checks.push(pass("signature.structure", "signature object is present"));
      checks.push(
        pass("signature.verify", "Ed25519 signature and artifact digests verify against the resolved public key", {
          key_source: publicKeySource || "unknown"
        })
      );
    } catch (error) {
      checks.push(pass("signature.structure", "signature object is present"));
      checks.push(
        fail("signature.verify", error?.message || String(error), {
          code: error?.code || "PLUGIN_SIGNATURE_INVALID",
          key_source: publicKeySource || "unknown"
        })
      );
    }
  } else {
    checks.push(skip("signature.structure", "skipped because semantic validation failed"));
    checks.push(skip("signature.verify", "skipped because semantic validation failed"));
  }

  // 9/10. key hygiene (directory context only)
  if (pluginDir) {
    const legacyKeyPath = path.join(pluginDir, LEGACY_PRIVATE_KEY_FILE);
    if (fs.existsSync(legacyKeyPath)) {
      checks.push(
        warn("hygiene.private_key", "a private key exists inside the plugin directory; never commit or share it", {
          artifact_path: LEGACY_PRIVATE_KEY_FILE,
          hint: "dis-plugin keygen moves publishing keys into the keyring"
        })
      );
    } else {
      checks.push(pass("hygiene.private_key", "no private key inside the plugin directory"));
    }
    const gitignorePath = path.join(pluginDir, ".gitignore");
    let coversKey = false;
    if (fs.existsSync(gitignorePath)) {
      const lines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
      coversKey = lines.some(
        (line) => line.trim() === LEGACY_PRIVATE_KEY_FILE || line.trim() === "*.key" || line.trim() === "plugin-signing-private.key"
      );
    }
    if (coversKey) {
      checks.push(pass("hygiene.gitignore", ".gitignore covers the legacy private key file"));
    } else {
      checks.push(
        warn("hygiene.gitignore", "plugin directory has no .gitignore entry covering " + LEGACY_PRIVATE_KEY_FILE)
      );
    }
  } else {
    checks.push(skip("hygiene.private_key", "zip input has no directory context"));
    checks.push(skip("hygiene.gitignore", "zip input has no directory context"));
  }

  // 11. pack readiness
  const signatureOk = checks.find((c) => c.id === "signature.verify")?.status === "PASS";
  const digestsOk = checks.find((c) => c.id === "artifacts.digest")?.status === "PASS";
  if (signatureOk && digestsOk && normalized) {
    checks.push(pass("pack.readiness", "package is signed and digests match; dis-plugin pack will succeed"));
  } else {
    checks.push(
      fail("pack.readiness", "package is not ready to pack: signature verification and digest checks must pass first")
    );
  }

  return finish(checks);
}

function finish(checks) {
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    const key = check.status.toLowerCase();
    if (key in summary) summary[key] += 1;
  }
  return {
    ok: summary.fail === 0,
    checks,
    summary
  };
}
