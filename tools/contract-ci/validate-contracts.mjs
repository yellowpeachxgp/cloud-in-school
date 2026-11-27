#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  CONTRACT_STATUSES,
  parseEndpointInventory,
  parseOpenApiOperations,
  partitionByStatus,
  routeKey
} from "./contract-utils.mjs";

const rootDir = process.cwd();

function assert(condition, message) {
  if (!condition) {
    console.error(`[CONTRACT-CI FAIL] ${message}`);
    process.exit(1);
  }
}

const systemContractPath = path.join(rootDir, "SYSTEM_CONTRACT.md");
assert(fs.existsSync(systemContractPath), "SYSTEM_CONTRACT.md must exist at repository root");
const systemContractText = fs.readFileSync(systemContractPath, "utf8");
assert(
  (systemContractText.includes("T-30") || systemContractText.includes("T−30")) &&
    (systemContractText.includes("T-5") || systemContractText.includes("T−5")),
  "SYSTEM_CONTRACT.md must enforce T-30m / T-5m / T triple schedule"
);
assert(systemContractText.includes("OpenAPI 3.1.2"), "SYSTEM_CONTRACT.md must enforce OpenAPI 3.1.2+");

const openApiPath = path.join(rootDir, "contracts/openapi/cloud-v1.yaml");
const inventoryPath = path.join(rootDir, "contracts/endpoints/endpoint-inventory.yaml");
assert(fs.existsSync(openApiPath), "contracts/openapi/cloud-v1.yaml must exist");
assert(fs.existsSync(inventoryPath), "contracts/endpoints/endpoint-inventory.yaml must exist");

const openApiText = fs.readFileSync(openApiPath, "utf8");
assert(openApiText.startsWith("openapi: 3.1.2"), "OpenAPI version must be >= 3.1.2");

function yamlScalar(value) {
  return String(value || "").trim().replace(/^['"]/, "").replace(/['"]$/, "");
}

function parseComponentParameters(lines) {
  const parameters = new Map();
  let inParameters = false;
  let currentName = null;
  for (const line of lines) {
    if (/^  parameters:\s*$/.test(line)) {
      inParameters = true;
      currentName = null;
      continue;
    }
    if (inParameters && /^  [A-Za-z0-9_-]+:\s*$/.test(line) && !/^  parameters:\s*$/.test(line)) {
      inParameters = false;
      currentName = null;
    }
    if (!inParameters) continue;
    const nameMatch = line.match(/^    ([A-Za-z0-9_-]+):\s*$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      parameters.set(currentName, {});
      continue;
    }
    if (!currentName) continue;
    const fieldMatch = line.match(/^      (name|in|required):\s*(.+?)\s*$/);
    if (fieldMatch) {
      parameters.get(currentName)[fieldMatch[1]] = yamlScalar(fieldMatch[2]);
    }
  }
  return parameters;
}

function parseOpenApiParameterDeclarations(lines) {
  const pathParameters = new Map();
  const operationParameters = new Map();
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;
  let parameterContext = null;
  let currentParameter = null;

  function appendParameter() {
    if (!currentParameter) return;
    if (parameterContext === "path" && currentPath) {
      if (!pathParameters.has(currentPath)) pathParameters.set(currentPath, []);
      pathParameters.get(currentPath).push(currentParameter);
    }
    if (parameterContext === "operation" && currentPath && currentMethod) {
      const key = currentMethod.toUpperCase() + " " + currentPath;
      if (!operationParameters.has(key)) operationParameters.set(key, []);
      operationParameters.get(key).push(currentParameter);
    }
    currentParameter = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
      appendParameter();
      inPaths = false;
      parameterContext = null;
      continue;
    }
    if (!inPaths) continue;

    const pathMatch = line.match(/^  (\/[^\s:]*):\s*$/);
    if (pathMatch) {
      appendParameter();
      currentPath = pathMatch[1];
      currentMethod = null;
      parameterContext = null;
      continue;
    }
    const methodMatch = line.match(/^    (get|post|patch|delete|put):\s*$/);
    if (methodMatch && currentPath) {
      appendParameter();
      currentMethod = methodMatch[1].toUpperCase();
      parameterContext = null;
      continue;
    }

    if (currentPath && !currentMethod && /^    parameters:\s*$/.test(line)) {
      appendParameter();
      parameterContext = "path";
      continue;
    }
    if (currentPath && currentMethod && /^      parameters:\s*$/.test(line)) {
      appendParameter();
      parameterContext = "operation";
      continue;
    }
    if (!parameterContext) continue;

    if (
      (parameterContext === "path" && /^    [A-Za-z0-9_-]+:\s*/.test(line) && !/^    parameters:\s*$/.test(line)) ||
      (parameterContext === "operation" && /^      [A-Za-z0-9_-]+:\s*/.test(line) && !/^      parameters:\s*$/.test(line))
    ) {
      appendParameter();
      parameterContext = null;
      continue;
    }

    const indent = (line.match(/^ */) || [""])[0].length;
    const expectedItemIndent = parameterContext === "path" ? 6 : 8;
    const itemMatch = indent === expectedItemIndent ? line.slice(expectedItemIndent).match(/^-\s+(.+?)\s*$/) : null;
    if (itemMatch) {
      appendParameter();
      const item = itemMatch[1];
      const refMatch = item.match(/^\$ref:\s*(.+?)\s*$/);
      const nameMatch = item.match(/^name:\s*(.+?)\s*$/);
      if (refMatch) {
        currentParameter = { ref: yamlScalar(refMatch[1]), line: index + 1 };
      } else if (nameMatch) {
        currentParameter = { name: yamlScalar(nameMatch[1]), line: index + 1 };
      }
      continue;
    }
    if (!currentParameter) continue;
    const fieldMatch = indent === expectedItemIndent + 2
      ? line.slice(expectedItemIndent + 2).match(/^(name|in|required):\s*(.+?)\s*$/)
      : null;
    if (fieldMatch) {
      currentParameter[fieldMatch[1]] = yamlScalar(fieldMatch[2]);
    }
  }
  appendParameter();
  return { pathParameters, operationParameters };
}

function templateParametersForPath(pathTemplate) {
  return [...new Set([...pathTemplate.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]))];
}

function resolveParameterDeclaration(declaration, componentParameters, displayKey) {
  if (!declaration.ref) return declaration;
  const prefix = "#/components/parameters/";
  assert(declaration.ref.startsWith(prefix), "Unsupported parameter $ref at " + displayKey + ": " + declaration.ref);
  const componentName = declaration.ref.slice(prefix.length);
  const component = componentParameters.get(componentName);
  assert(component, "Missing components/parameters/" + componentName + " referenced by " + displayKey);
  return { ...component, ref: declaration.ref, line: declaration.line };
}

function assertStrictPathTemplateParameters(lines) {
  const componentParameters = parseComponentParameters(lines);
  const declarations = parseOpenApiParameterDeclarations(lines);
  for (const [key, operationId] of openApiOps.entries()) {
    const splitAt = key.indexOf(" ");
    const pathTemplate = key.slice(splitAt + 1);
    const templateParameters = templateParametersForPath(pathTemplate);
    const templateSet = new Set(templateParameters);
    const rawDeclarations = [
      ...(declarations.pathParameters.get(pathTemplate) || []),
      ...(declarations.operationParameters.get(key) || [])
    ];
    const resolved = rawDeclarations.map((declaration) =>
      resolveParameterDeclaration(declaration, componentParameters, key + " (" + operationId + ")")
    );
    for (const parameterName of templateParameters) {
      const matches = resolved.filter((declaration) => declaration.name === parameterName);
      assert(
        matches.length > 0,
        "Missing required path parameter declaration for " + key + " (" + operationId + "): " + parameterName
      );
      for (const match of matches) {
        assert(
          match.in === "path",
          "Path template parameter " + parameterName + " for " + key + " (" + operationId + ") must declare in: path"
        );
        assert(
          match.required === "true",
          "Path template parameter " + parameterName + " for " + key + " (" + operationId + ") must declare required: true"
        );
      }
    }
    for (const declaration of resolved) {
      if (declaration.in !== "path") continue;
      assert(
        templateSet.has(declaration.name),
        "Declared path parameter " + declaration.name + " is not present in path template " + pathTemplate + " (" + operationId + ")"
      );
    }
  }
}

// Extract paths & methods from OpenAPI YAML, including explicit lifecycle metadata.
const lines = openApiText.split(/\r?\n/);
const openApiOperations = parseOpenApiOperations(openApiText);
const openApiOps = new Map();
const openApiOperationByKey = new Map();
const openApiOperationIds = new Set();
for (const operation of openApiOperations) {
  const key = routeKey(operation);
  assert(
    CONTRACT_STATUSES.includes(operation.status),
    `Unsupported x-dis-status for ${key} (${operation.operationId}): ${operation.status}`
  );
  assert(!openApiOperationIds.has(operation.operationId), `Duplicate operationId in OpenAPI: ${operation.operationId}`);
  assert(!openApiOps.has(key), `Duplicate method+path in OpenAPI: ${key}`);
  openApiOperationIds.add(operation.operationId);
  openApiOps.set(key, operation.operationId);
  openApiOperationByKey.set(key, operation);
}

assert(openApiOps.size >= 45, `Expected at least 45 operations in OpenAPI, found ${openApiOps.size}`);
assertStrictPathTemplateParameters(lines);

// Parse error and permission catalogs used by machine-readable operation metadata.
const errorCatalogPath = path.join(rootDir, "contracts/errors/error-catalog.yaml");
const permissionCatalogPath = path.join(rootDir, "contracts/permissions/permission-catalog.yaml");
const asyncApiPath = path.join(rootDir, "contracts/asyncapi/events-v1.yaml");
assert(fs.existsSync(errorCatalogPath), "contracts/errors/error-catalog.yaml must exist");
assert(fs.existsSync(permissionCatalogPath), "contracts/permissions/permission-catalog.yaml must exist");
assert(fs.existsSync(asyncApiPath), "contracts/asyncapi/events-v1.yaml must exist");
const errorCatalogText = fs.readFileSync(errorCatalogPath, "utf8");
const permissionCatalogText = fs.readFileSync(permissionCatalogPath, "utf8");
const asyncApiText = fs.readFileSync(asyncApiPath, "utf8");
const catalogErrorCodes = new Set(
  [...errorCatalogText.matchAll(/^\s*-\s*code:\s*([A-Z0-9_]+)\s*$/gm)].map((match) => match[1])
);
const catalogPermissionIds = new Set(
  [...permissionCatalogText.matchAll(/^\s*-\s*id:\s*([A-Za-z0-9._-]+)\s*$/gm)].map((match) => match[1])
);

// Parse endpoint-inventory.yaml. Missing status means active for backward compatibility;
// planned/reserved entries are contract-only until a future implementation card flips them.
const invText = fs.readFileSync(inventoryPath, "utf8");
const inventoryOperations = parseEndpointInventory(invText);
const invOps = new Map();
const inventoryOperationByKey = new Map();
const inventoryOperationIds = new Set();
for (const endpoint of inventoryOperations) {
  const key = routeKey(endpoint);
  assert(endpoint.method && endpoint.path && endpoint.operationId, `Incomplete endpoint inventory entry: ${key}`);
  assert(endpoint.auth, `Missing auth mode in endpoint inventory entry: ${key}`);
  assert(endpoint.owner, `Missing owner in endpoint inventory entry: ${key}`);
  assert(
    CONTRACT_STATUSES.includes(endpoint.status),
    `Unsupported endpoint inventory status for ${key} (${endpoint.operationId}): ${endpoint.status}`
  );
  assert(!inventoryOperationIds.has(endpoint.operationId), `Duplicate operationId in endpoint inventory: ${endpoint.operationId}`);
  assert(!invOps.has(key), `Duplicate method+path in endpoint inventory: ${key}`);
  if (endpoint.status === "planned" || endpoint.status === "reserved") {
    assert(
      typeof endpoint.contractCard === "string" && /^CT-[0-9]+$/.test(endpoint.contractCard),
      `Missing machine-readable contract_card for ${endpoint.status} endpoint: ${key}`
    );
  }
  inventoryOperationIds.add(endpoint.operationId);
  invOps.set(key, endpoint.operationId);
  inventoryOperationByKey.set(key, endpoint);
}

// OpenAPI and endpoint inventory must be identical within each lifecycle class.
// In particular, active remains the runtime parity surface; planned/reserved are explicit
// contract-only surfaces rather than hidden extra operations.
const openApiPartitions = partitionByStatus(openApiOperations);
const inventoryPartitions = partitionByStatus(inventoryOperations);
assert(openApiPartitions.unknown.length === 0, "OpenAPI contains operations with unknown x-dis-status");
assert(inventoryPartitions.unknown.length === 0, "endpoint inventory contains operations with unknown status");
for (const status of CONTRACT_STATUSES) {
  const openApiForStatus = openApiPartitions[status];
  const inventoryForStatus = inventoryPartitions[status];
  assert(
    openApiForStatus.length === inventoryForStatus.length,
    `${status} endpoint count mismatch: OpenAPI=${openApiForStatus.length} Inventory=${inventoryForStatus.length}`
  );
  const inventoryKeys = new Map(inventoryForStatus.map((endpoint) => [routeKey(endpoint), endpoint]));
  const openApiKeys = new Map(openApiForStatus.map((operation) => [routeKey(operation), operation]));
  for (const operation of openApiForStatus) {
    const key = routeKey(operation);
    const inventory = inventoryKeys.get(key);
    assert(inventory, `${status} endpoint missing from endpoint-inventory.yaml: ${key}`);
    assert(
      inventory.operationId === operation.operationId,
      `operationId mismatch for ${key}: OpenAPI=${operation.operationId} vs Inventory=${inventory.operationId}`
    );
  }
  for (const endpoint of inventoryForStatus) {
    assert(openApiKeys.has(routeKey(endpoint)), `${status} inventory endpoint missing from OpenAPI: ${routeKey(endpoint)}`);
  }
}

function operationBlock(operation) {
  const start = operation.line - 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^components:\s*$/.test(line) || /^  \//.test(line) || /^    (get|post|patch|delete|put):\s*$/.test(line)) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Validate machine-readable CT metadata. This is deliberately strict only for planned/reserved
// operations so the existing active contract is not rewritten merely to satisfy new metadata.
const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
for (const operation of openApiOperations) {
  const key = routeKey(operation);
  for (const code of operation.errorCodes) {
    assert(catalogErrorCodes.has(code), `x-dis-error-codes references missing error catalog code ${code} at ${key}`);
  }
  for (const permission of operation.permissions) {
    assert(catalogPermissionIds.has(permission), `x-dis-permissions references missing permission ${permission} at ${key}`);
  }
  for (const eventName of operation.events) {
    assert(
      asyncApiText.includes("  " + eventName + ":\n"),
      `x-dis-events references missing AsyncAPI channel ${eventName} at ${key}`
    );
  }
  if (operation.status !== "planned" && operation.status !== "reserved") continue;
  assert(operation.apiVersion === "v1", `${operation.status} endpoint must declare x-dis-api-version: v1 at ${key}`);
  assert(operation.compatibility, `${operation.status} endpoint must declare x-dis-compatibility at ${key}`);
  assert(operation.permissions.length > 0, `${operation.status} endpoint must declare x-dis-permissions at ${key}`);
  assert(operation.errorCodes.length > 0, `${operation.status} endpoint must declare x-dis-error-codes at ${key}`);
  if (operation.status === "planned" && writeMethods.has(operation.method)) {
    assert(
      operation.idempotency === "required",
      `planned write endpoint must declare x-dis-idempotency: required at ${key}`
    );
    const block = operationBlock(operation);
    assert(
      block.includes("#/components/parameters/IdempotencyKeyHeader") || block.includes("name: Idempotency-Key"),
      `planned write endpoint must declare the Idempotency-Key header at ${key}`
    );
  }
}

// Validate JSON Schemas
const schemaDir = path.join(rootDir, "contracts/schemas");
const schemaFiles = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
assert(schemaFiles.length >= 4, "Expected at least 4 JSON schemas in contracts/schemas");
for (const file of schemaFiles) {
  const parsed = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
  assert(
    parsed.$schema === "https://json-schema.org/draft/2020-12/schema",
    `Schema ${file} must use draft 2020-12`
  );
  assert(typeof parsed.title === "string" && parsed.title.length > 0, `Schema ${file} must have a title`);
}

console.log(
  `[CONTRACT-CI PASS] Verified SYSTEM_CONTRACT.md, ${openApiPartitions.active.length} active + ${openApiPartitions.planned.length} planned + ${openApiPartitions.reserved.length} reserved OpenAPI 3.1.2 operations (100% lifecycle inventory parity), and ${schemaFiles.length} JSON Schema 2020-12 files.`
);
