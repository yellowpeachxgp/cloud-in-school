import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError } from "../../contracts/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_PLUGIN_SCHEMA_PATH = path.resolve(
  __dirname,
  "../schema/plugin-extension-v2-runtime.schema.json"
);
export const RUNTIME_HOST_API_MATRIX_PATH = path.resolve(
  __dirname,
  "../runtime/host-api-matrix.json"
);

export const RUNTIME_VALIDATION_CODES = Object.freeze({
  SCHEMA_INVALID: "runtime_schema_invalid",
  FORMAT_UNSUPPORTED: "runtime_format_unsupported",
  HOST_API_RANGE_INVALID: "runtime_host_api_range_invalid",
  HOST_API_OUT_OF_RANGE: "runtime_host_api_out_of_range",
  PERMISSION_UNKNOWN: "runtime_permission_unknown",
  ORIGIN_INVALID: "runtime_origin_invalid",
  SLOT_UNKNOWN: "runtime_slot_unknown",
  PATH_UNSAFE: "runtime_path_unsafe",
  DIGEST_INVALID: "runtime_digest_invalid",
  SIGNATURE_INVALID: "runtime_signature_invalid"
});

export function loadRuntimePluginManifestSchema() {
  return JSON.parse(fs.readFileSync(RUNTIME_PLUGIN_SCHEMA_PATH, "utf8"));
}

export function loadRuntimeHostApiMatrix() {
  return JSON.parse(fs.readFileSync(RUNTIME_HOST_API_MATRIX_PATH, "utf8"));
}

export function runtimeHostApiEntry(hostApiVersion = 2) {
  const matrix = loadRuntimeHostApiMatrix();
  return (matrix.host_api_versions || []).find((entry) => entry.host_api === hostApiVersion) || null;
}

export function runtimeSupportedUiSlots(hostApiVersion = 2) {
  return Object.freeze([...(runtimeHostApiEntry(hostApiVersion)?.supported_ui_slots || [])]);
}

export const RUNTIME_UI_SLOTS = runtimeSupportedUiSlots(2);

function typeOfJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  return typeof value === expected;
}

function issue(path, keyword, message, extra = {}) {
  return { path, keyword, message, ...extra };
}

function validateJsonSchemaValue(value, schema, currentPath = "$", issues = []) {
  if (!schema || typeof schema !== "object") return issues;

  // Type is checked before enum/const so a wrongly typed value is reported as
  // a schema-shape error rather than being misclassified as an unsupported
  // format, permission, slot, or digest value. This ordering is part of the
  // cloud/Android runtime parity contract used by the W6-00 fixtures.
  if (schema.type && !typeMatches(value, schema.type)) {
    issues.push(
      issue(
        currentPath,
        "type",
        `${currentPath} must be ${schema.type}, got ${typeOfJson(value)}`
      )
    );
    return issues;
  }
  if (schema.const !== undefined && value !== schema.const) {
    issues.push(issue(currentPath, "const", `${currentPath} must equal ${JSON.stringify(schema.const)}`));
    return issues;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(issue(currentPath, "enum", `${currentPath} must be one of ${schema.enum.join(", ")}`));
    return issues;
  }

  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(issue(currentPath, "minLength", `${currentPath} is shorter than ${schema.minLength} characters`));
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push(issue(currentPath, "maxLength", `${currentPath} is longer than ${schema.maxLength} characters`));
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      issues.push(issue(currentPath, "pattern", `${currentPath} does not match required pattern`));
    }
  }

  if ((schema.type === "integer" || schema.type === "number") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(issue(currentPath, "minimum", `${currentPath} must be >= ${schema.minimum}`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(issue(currentPath, "maximum", `${currentPath} must be <= ${schema.maximum}`));
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(issue(currentPath, "minItems", `${currentPath} must contain at least ${schema.minItems} items`));
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateJsonSchemaValue(item, schema.items, `${currentPath}[${index}]`, issues);
      });
    }
  }

  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in value)) {
        issues.push(
          issue(currentPath, "required", `${currentPath} is missing required property ${requiredKey}`, {
            missingProperty: requiredKey
          })
        );
      }
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          issues.push(
            issue(`${currentPath}.${key}`, "additionalProperties", `${currentPath}.${key} is not an allowed property`, {
              additionalProperty: key
            })
          );
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        validateJsonSchemaValue(value[key], propertySchema, `${currentPath}.${key}`, issues);
      }
    }
  }
  return issues;
}

export function validatePluginRuntimeSchema(manifest) {
  const schema = loadRuntimePluginManifestSchema();
  return validateJsonSchemaValue(manifest, schema);
}

export function runtimeValidationCodeForSchemaIssue(item) {
  const pathText = item?.path || "";
  const missing = item?.missingProperty || "";
  if (pathText === "$.schema_version" || missing === "schema_version") {
    return item.keyword === "enum" ? RUNTIME_VALIDATION_CODES.FORMAT_UNSUPPORTED : RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
  }
  if (pathText.startsWith("$.allowed_origins[")) {
    return item.keyword === "pattern" ? RUNTIME_VALIDATION_CODES.ORIGIN_INVALID : RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
  }
  if (pathText.startsWith("$.permissions") || pathText.includes("required_permission")) {
    return item.keyword === "enum" ? RUNTIME_VALIDATION_CODES.PERMISSION_UNKNOWN : RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
  }
  if (pathText.startsWith("$.ui_slots") && pathText.endsWith(".slot_id")) {
    return item.keyword === "enum" ? RUNTIME_VALIDATION_CODES.SLOT_UNKNOWN : RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
  }
  if (pathText.startsWith("$.entry_artifacts") && pathText.endsWith(".sha256")) {
    return item.keyword === "pattern" ? RUNTIME_VALIDATION_CODES.DIGEST_INVALID : RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
  }
  if (pathText.startsWith("$.signature")) {
    return RUNTIME_VALIDATION_CODES.SIGNATURE_INVALID;
  }
  return RUNTIME_VALIDATION_CODES.SCHEMA_INVALID;
}

function contractErrorCodeForRuntimeValidation(runtimeCode) {
  if (runtimeCode === RUNTIME_VALIDATION_CODES.PERMISSION_UNKNOWN) return "PLUGIN_PERMISSION_DENIED";
  if (
    runtimeCode === RUNTIME_VALIDATION_CODES.DIGEST_INVALID ||
    runtimeCode === RUNTIME_VALIDATION_CODES.SIGNATURE_INVALID
  ) {
    return "PLUGIN_SIGNATURE_INVALID";
  }
  return "BAD_REQUEST";
}

export function pluginManifestValidationError(runtimeCode, message, detail = {}) {
  return new ContractError(contractErrorCodeForRuntimeValidation(runtimeCode), message, {
    runtime_validation_code: runtimeCode,
    ...detail
  });
}

export function assertPluginRuntimeSchema(manifest) {
  const issues = validatePluginRuntimeSchema(manifest);
  if (issues.length === 0) return;
  const first = issues[0];
  const runtimeCode = runtimeValidationCodeForSchemaIssue(first);
  throw pluginManifestValidationError(runtimeCode, `Plugin manifest runtime schema violation: ${first.message}`, {
    schema_path: first.path,
    schema_keyword: first.keyword,
    issue_count: issues.length
  });
}
