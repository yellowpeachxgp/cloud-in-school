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
assertStrictPathTemplateParameters(lines);

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
