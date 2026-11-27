// W6-01b: deterministic, dependency-free ZIP writer and strict ZIP reader for
// dis-extension/v2 plugin packages (.zip transport format produced by "dis-plugin pack").
//
// Format contract (documented in docs/PLUGIN_SDK_GUIDE.md):
//   - entries: manifest.json + plugin-signing-public.key (optional) + declared artifacts only
//   - deflate (method 8) compression, fixed DOS timestamp 1980-01-01 00:00:00, entries sorted
//     by path so identical content produces byte-identical archives (reproducible builds)
//   - reader enforces the same safety envelope as the Android package pipeline: zip-slip /
//     absolute path / backslash / NUL rejection, duplicate detection, entry count and size caps,
//     central-directory-driven (never trusts local header sizes), CRC-32 and size verification,
//     and bounded inflation — output bytes are counted as the deflate stream is produced and
//     decompression aborts at the declared-size cap, so a header lying about a tiny size can
//     never trick the reader into materializing a zip bomb in memory.
import zlib from "node:zlib";
import { ContractError } from "../../contracts/src/index.mjs";
import {
  assertSafeRelativeArtifactPath,
  parsePluginManifestJson,
  validatePluginManifest
} from "./index.mjs";
import { sha256Hex } from "../../crypto/src/index.mjs";

// Aligned with Android PackageLimits (core/school-packages PackageBundle.kt) so a
// pack archive accepted here stays within the envelope the Android side enforces.
export const PLUGIN_PACKAGE_ZIP_LIMITS = Object.freeze({
  maxEntries: 512,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxPathLength: 200,
  maxPathDepth: 8
});

export const PLUGIN_PACKAGE_MANIFEST_ENTRY = "manifest.json";
export const PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY = "plugin-signing-public.key";

function zipError(code, message, detail = {}) {
  return new ContractError(code, message, detail);
}

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309, table-driven). Node exposes no crc32 primitive in zlib.
// ---------------------------------------------------------------------------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTimeFixed() {
  // 1980-01-01 00:00:00 — the earliest representable DOS timestamp, used for every
  // entry so archives are byte-reproducible regardless of when they are built.
  return { time: 0, date: (1 << 5) | 1 | (0 << 9) }; // month=1 day=1 year=1980(0+1980)
}

/**
 * Write a deterministic ZIP archive.
 * @param {Array<[string, Buffer]>} entries list of [safeRelativePath, content]
 * @returns {Buffer} archive bytes
 */
export function writePluginPackageZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw zipError("BAD_REQUEST", "pack requires at least one entry");
  }
  if (entries.length > PLUGIN_PACKAGE_ZIP_LIMITS.maxEntries) {
    throw zipError("BAD_REQUEST", "pack entry count exceeds limit", {
      limit: PLUGIN_PACKAGE_ZIP_LIMITS.maxEntries
    });
  }

  const prepared = entries.map(([rawPath, content]) => {
    const safePath = assertSafeRelativeArtifactPath(rawPath);
    if (safePath.length > PLUGIN_PACKAGE_ZIP_LIMITS.maxPathLength) {
      throw zipError("BAD_REQUEST", "pack entry path exceeds length limit", { artifact_path: rawPath });
    }
    if (safePath.split("/").length > PLUGIN_PACKAGE_ZIP_LIMITS.maxPathDepth) {
      throw zipError("BAD_REQUEST", "pack entry path exceeds depth limit", { artifact_path: rawPath });
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    if (buf.length > PLUGIN_PACKAGE_ZIP_LIMITS.maxFileBytes) {
      throw zipError("BAD_REQUEST", "pack entry exceeds per-file size limit", { artifact_path: rawPath });
    }
    return { path: safePath, content: buf };
  });

  // Duplicate detection (exact and case-insensitive, mirroring the Android pipeline).
  const seenExact = new Set();
  const seenLower = new Set();
  for (const entry of prepared) {
    if (seenExact.has(entry.path) || seenLower.has(entry.path.toLowerCase())) {
      throw zipError("BAD_REQUEST", "duplicate entry in pack input", { artifact_path: entry.path });
    }
    seenExact.add(entry.path);
    seenLower.add(entry.path.toLowerCase());
  }

  const totalBytes = prepared.reduce((sum, entry) => sum + entry.content.length, 0);
  if (totalBytes > PLUGIN_PACKAGE_ZIP_LIMITS.maxTotalBytes) {
    throw zipError("BAD_REQUEST", "pack uncompressed total exceeds limit", {
      limit: PLUGIN_PACKAGE_ZIP_LIMITS.maxTotalBytes
    });
  }

  prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const { time, date } = dosDateTimeFixed();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of prepared) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const compressed = zlib.deflateRawSync(entry.content, { level: 9 });
    // Fall back to STORE when deflate does not help (tiny or incompressible entries).
    const useStore = compressed.length >= entry.content.length;
    const method = useStore ? 0 : 8;
    const payload = useStore ? entry.content : compressed;
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, nameBytes]));

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralStart = offset;
  const centralBlob = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central disk
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBlob, eocd]);
}

function zipStructureError(message, detail = {}) {
  return zipError("PLUGIN_SIGNATURE_INVALID", message, {
    runtime_validation_code: "runtime_path_unsafe",
    zip_structure: true,
    ...detail
  });
}

// Zip-bomb protection (review 2026-11-27): never inflate without a hard output
// cap. The previous implementation called inflateRawSync unbounded and compared
// lengths afterwards, so an archive declaring a tiny uncompressed size still
// inflated the full attacker-controlled stream into memory first (measured RSS
// +210MB for a single entry). zlib's maxOutputLength counts output bytes as the
// stream is produced and aborts with ERR_BUFFER_TOO_LARGE the moment the cap is
// exceeded, so resident memory stays bounded by the cap rather than by the
// stream (probe: 1 GiB deflate bomb with a 4 MiB cap aborts with ~6 MiB RSS
// delta). The cap is the declared uncompressed size itself — already enforced
// <= maxFileBytes before inflation — clamped into the valid option range
// [1, ...]: honest entries always fit exactly, and any stream producing more
// than declared is precisely the tamper case the size comparison rejects.
function inflateEntryBounded(compressed, declaredSize, artifactPath) {
  const cap = Math.max(1, Math.min(declaredSize, PLUGIN_PACKAGE_ZIP_LIMITS.maxFileBytes));
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: cap });
  } catch (error) {
    if (error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw zipStructureError(
        "Zip entry uncompressed size mismatch with central directory (output exceeds declared size; bounded inflation zip-bomb protection)",
        { artifact_path: artifactPath, declared_size: declaredSize }
      );
    }
    throw zipStructureError("Zip entry deflate stream is corrupt", {
      artifact_path: artifactPath,
      inflate_error: error?.message || String(error)
    });
  }
}

/**
 * Strictly read a ZIP archive produced for plugin transport.
 * @param {Buffer} archive
 * @returns {{ entries: Map<string, Buffer> }} insertion-ordered by central directory
 */
export function readPluginPackageZip(archive) {
  const buf = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  const limits = PLUGIN_PACKAGE_ZIP_LIMITS;
  if (buf.length < 22) {
    throw zipStructureError("Not a plugin package zip: archive smaller than EOCD record");
  }

  // Locate the End Of Central Directory record within the trailing window.
  const window = Math.min(buf.length, 22 + 65535);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= buf.length - window; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw zipStructureError("Not a plugin package zip: end of central directory not found");
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const centralDisk = buf.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw zipStructureError("Multi-disk zip archives are not supported");
  }
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralSize = buf.readUInt32LE(eocdOffset + 12);
  const centralOffset = buf.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipStructureError("ZIP64 archives are not supported for plugin packages");
  }
  if (entryCount > limits.maxEntries) {
    throw zipStructureError("Zip entry count exceeds plugin package limit", {
      entry_count: entryCount,
      limit: limits.maxEntries
    });
  }
  if (centralOffset + centralSize > buf.length) {
    throw zipStructureError("Central directory points outside the archive");
  }

  const entries = new Map();
  const seenLower = new Set();
  let totalUncompressed = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw zipStructureError("Central directory entry is malformed", { entry_index: index });
    }
    const flags = buf.readUInt16LE(cursor + 8);
    if (flags & 0x0001) {
      throw zipStructureError("Encrypted zip entries are not supported", { entry_index: index });
    }
    const method = buf.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) {
      throw zipStructureError("Unsupported zip compression method (only store/deflate)", {
        entry_index: index,
        method
      });
    }
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw zipStructureError("ZIP64 entry metadata is not supported", { entry_index: index });
    }
    const nameBytes = buf.subarray(cursor + 46, cursor + 46 + nameLength);
    const entryPath = nameBytes.toString("utf8");

    let safePath;
    try {
      safePath = assertSafeRelativeArtifactPath(entryPath);
    } catch (error) {
      throw zipStructureError("Zip entry path rejected by zip-slip/traversal protection", {
        entry_index: index,
        artifact_path: entryPath
      });
    }
    if (safePath !== entryPath) {
      throw zipStructureError("Zip entry path must already be in normalized posix form", {
        artifact_path: entryPath
      });
    }
    if (safePath.length > limits.maxPathLength || safePath.split("/").length > limits.maxPathDepth) {
      throw zipStructureError("Zip entry path exceeds plugin package limits", { artifact_path: entryPath });
    }
    if (entries.has(safePath) || seenLower.has(safePath.toLowerCase())) {
      throw zipStructureError("Duplicate zip entry rejected", { artifact_path: entryPath });
    }
    if (uncompressedSize > limits.maxFileBytes) {
      throw zipStructureError("Zip entry exceeds per-file size limit (pre-inflation cap)", {
        artifact_path: entryPath,
        uncompressed_size: uncompressedSize
      });
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalBytes) {
      throw zipStructureError("Zip uncompressed total exceeds plugin package limit (zip-bomb protection)", {
        total_uncompressed: totalUncompressed,
        limit: limits.maxTotalBytes
      });
    }

    // Resolve the data position through the local header; sizes come from the
    // central directory only, so a lying local header cannot redirect the read.
    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw zipStructureError("Local file header missing for central directory entry", {
        artifact_path: entryPath
      });
    }
    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    // Strict consistency: the local header name must be byte-identical to the
    // central directory name. Central-driven readers otherwise silently accept
    // archives whose two name copies disagree, which is a classic tamper signal.
    const localNameBytes = buf.subarray(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLength
    );
    if (!localNameBytes.equals(nameBytes)) {
      throw zipStructureError("Zip local header name does not match central directory name", {
        artifact_path: entryPath
      });
    }
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw zipStructureError("Zip entry data extends beyond the archive end", {
        artifact_path: entryPath
      });
    }
    const compressed = buf.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) {
      // STORE entries are uncompressed by definition, so their two sizes must be
      // identical. Checking before copying keeps a lying header from turning the
      // copy itself into an unbounded allocation.
      if (compressedSize !== uncompressedSize) {
        throw zipStructureError("Zip stored entry size fields disagree (tamper signal)", {
          artifact_path: entryPath,
          compressed_size: compressedSize,
          uncompressed_size: uncompressedSize
        });
      }
      content = Buffer.from(compressed);
    } else {
      content = inflateEntryBounded(compressed, uncompressedSize, entryPath);
    }
    if (content.length !== uncompressedSize) {
      throw zipStructureError("Zip entry uncompressed size mismatch with central directory", {
        artifact_path: entryPath
      });
    }
    if ((crc32(content) >>> 0) !== expectedCrc) {
      throw zipStructureError("Zip entry CRC-32 mismatch", { artifact_path: entryPath });
    }

    entries.set(safePath, content);
    seenLower.add(safePath.toLowerCase());
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries };
}

/**
 * Unpack and validate a plugin package zip into the same shape as loadPluginDirectory.
 * Enforces the closed-world content rule: the archive may only contain manifest.json,
 * an optional plugin-signing-public.key, and the artifacts declared in the manifest.
 */
export function unpackPluginPackage(archive) {
  const { entries } = readPluginPackageZip(archive);
  const manifestBytes = entries.get(PLUGIN_PACKAGE_MANIFEST_ENTRY);
  if (!manifestBytes) {
    throw zipError("PLUGIN_SIGNATURE_INVALID", "Plugin package zip does not contain manifest.json");
  }
  const manifest = parsePluginManifestJson(manifestBytes.toString("utf8"));
  const normalized = validatePluginManifest(manifest);

  const artifactMap = {};
  const declaredPaths = new Set();
  for (const declared of normalized.entry_artifacts || []) {
    const safePath = assertSafeRelativeArtifactPath(declared.path);
    declaredPaths.add(safePath);
    const content = entries.get(safePath);
    if (!content) {
      throw zipError(
        "PLUGIN_SIGNATURE_INVALID",
        "Declared artifact is missing from plugin package zip",
        { artifact_path: safePath }
      );
    }
    if (sha256Hex(content) !== declared.sha256) {
      throw zipError("PLUGIN_SIGNATURE_INVALID", "Artifact digest mismatch inside plugin package zip", {
        artifact_path: safePath
      });
    }
    artifactMap[safePath] = content;
  }

  for (const entryPath of entries.keys()) {
    if (
      entryPath !== PLUGIN_PACKAGE_MANIFEST_ENTRY &&
      entryPath !== PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY &&
      !declaredPaths.has(entryPath)
    ) {
      throw zipError("PLUGIN_SIGNATURE_INVALID", "Plugin package zip contains an undeclared entry", {
        artifact_path: entryPath
      });
    }
  }

  const publicKeyBytes = entries.get(PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY);
  return {
    manifest: normalized,
    artifactMap,
    publicKeyBase64: publicKeyBytes ? publicKeyBytes.toString("utf8").trim() : null
  };
}

/**
 * Build the entry list for a pack archive from a validated plugin directory layout.
 * The manifest bytes are the exact bytes of the signed manifest on disk so that the
 * archive transports bit-identical evidence.
 */
export function buildPackEntries({ manifestBytes, artifactEntries, publicKeyBase64 = null }) {
  const entries = [[PLUGIN_PACKAGE_MANIFEST_ENTRY, Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes, "utf8")]];
  if (publicKeyBase64) {
    entries.push([PLUGIN_PACKAGE_PUBLIC_KEY_ENTRY, Buffer.from(String(publicKeyBase64).trim() + "\n", "utf8")]);
  }
  for (const [artifactPath, content] of artifactEntries) {
    entries.push([artifactPath, content]);
  }
  return entries;
}
