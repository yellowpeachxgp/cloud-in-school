#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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

// Extract paths & methods from OpenAPI YAML
const openApiOps = new Map();
const operationIds = new Set();
const lines = openApiText.split(/\r?\n/);
let inPaths = false;
let currentPath = null;
let currentMethod = null;

for (const line of lines) {
  if (/^paths:\s*$/.test(line)) {
    inPaths = true;
    continue;
  }
  if (inPaths && /^[a-zA-Z0-9_-]+:\s*$/.test(line)) {
    inPaths = false;
    continue;
  }
  if (!inPaths) continue;

  const pathMatch = line.match(/^  (\/[^\s:]*):\s*$/);
  if (pathMatch) {
    currentPath = pathMatch[1];
    currentMethod = null;
    continue;
  }
  const methodMatch = line.match(/^    (get|post|patch|delete|put):\s*$/);
  if (methodMatch && currentPath) {
    currentMethod = methodMatch[1].toUpperCase();
    continue;
  }
  const opIdMatch = line.match(/^      operationId:\s*([a-zA-Z0-9_]+)\s*$/);
  if (opIdMatch && currentPath && currentMethod) {
    const opId = opIdMatch[1];
    assert(!operationIds.has(opId), `Duplicate operationId in OpenAPI: ${opId}`);
    operationIds.add(opId);
    openApiOps.set(`${currentMethod} ${currentPath}`, opId);
  }
}

assert(openApiOps.size >= 45, `Expected at least 45 operations in OpenAPI, found ${openApiOps.size}`);

// Parse endpoint-inventory.yaml
const invText = fs.readFileSync(inventoryPath, "utf8");
const invOps = new Map();
let invMethod = null;
let invPath = null;
for (const line of invText.split(/\r?\n/)) {
  const mMatch = line.match(/^\s*-\s*method:\s*([A-Z]+)\s*$/);
  if (mMatch) {
    invMethod = mMatch[1];
    invPath = null;
    continue;
  }
  const pMatch = line.match(/^\s*path:\s*(\/[^\s]*)\s*$/);
  if (pMatch) {
    invPath = pMatch[1];
    continue;
  }
  const oMatch = line.match(/^\s*operationId:\s*([a-zA-Z0-9_]+)\s*$/);
  if (oMatch && invMethod && invPath) {
    invOps.set(`${invMethod} ${invPath}`, oMatch[1]);
  }
}

for (const [key, opId] of openApiOps.entries()) {
  assert(invOps.has(key), `Endpoint missing from endpoint-inventory.yaml: ${key}`);
  assert(invOps.get(key) === opId, `operationId mismatch for ${key}: OpenAPI=${opId} vs Inventory=${invOps.get(key)}`);
}
for (const [key] of invOps.entries()) {
  assert(openApiOps.has(key), `Inventory endpoint missing from OpenAPI: ${key}`);
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
  `[CONTRACT-CI PASS] Verified SYSTEM_CONTRACT.md, ${openApiOps.size} OpenAPI 3.1.2 operations (100% inventory parity), and ${schemaFiles.length} JSON Schema 2020-12 files.`
);
