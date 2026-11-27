#!/usr/bin/env node
// Shared, dependency-free parsers for the repository contract YAML subset.
// These helpers intentionally understand only the stable line-oriented shape used in
// contracts/openapi/cloud-v1.yaml and contracts/endpoints/endpoint-inventory.yaml.

export const CONTRACT_STATUSES = Object.freeze(["active", "planned", "reserved"]);
export const NON_RUNTIME_CONTRACT_STATUSES = Object.freeze(["planned", "reserved"]);

const OPENAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

function scalar(value) {
  return String(value || "").trim().replace(/^['"]/, "").replace(/['"]$/, "");
}

function inlineList(value) {
  const trimmed = scalar(value);
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => scalar(item)).filter(Boolean);
}

export function routeKey(route) {
  return route.method + " " + route.path;
}

export function parseOpenApiOperations(yamlText) {
  const operations = [];
  const lines = yamlText.split(/\r?\n/);
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;
  let currentOperation = null;
  let pendingStatus = null;
  let pendingPermissions = [];
  let pendingErrorCodes = [];
  let pendingIdempotency = null;
  let pendingApiVersion = null;
  let pendingCompatibility = null;
  let pendingEvents = [];

  function resetOperationState() {
    currentOperation = null;
    pendingStatus = null;
    pendingPermissions = [];
    pendingErrorCodes = [];
    pendingIdempotency = null;
    pendingApiVersion = null;
    pendingCompatibility = null;
    pendingEvents = [];
  }

  function applyPending(operation) {
    if (pendingStatus) operation.status = pendingStatus;
    if (pendingPermissions.length) operation.permissions = [...pendingPermissions];
    if (pendingErrorCodes.length) operation.errorCodes = [...pendingErrorCodes];
    if (pendingIdempotency) operation.idempotency = pendingIdempotency;
    if (pendingApiVersion) operation.apiVersion = pendingApiVersion;
    if (pendingCompatibility) operation.compatibility = pendingCompatibility;
    if (pendingEvents.length) operation.events = [...pendingEvents];
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[^\s].*:\s*$/.test(line) && !line.startsWith("paths:")) break;

    const pathMatch = line.match(/^  (\/[^\s].*):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      resetOperationState();
      continue;
    }

    const methodMatch = line.match(/^    ([a-z]+):\s*$/);
    if (methodMatch && OPENAPI_HTTP_METHODS.has(methodMatch[1])) {
      currentMethod = methodMatch[1].toUpperCase();
      resetOperationState();
      continue;
    }

    if (!currentPath || !currentMethod) continue;

    const operationMatch = line.match(/^      operationId:\s*([A-Za-z0-9_]+)\s*$/);
    if (operationMatch) {
      const operation = {
        method: currentMethod,
        path: currentPath,
        operationId: operationMatch[1],
        status: "active",
        permissions: [],
        errorCodes: [],
        idempotency: null,
        apiVersion: null,
        compatibility: null,
        events: [],
        line: lineIndex + 1
      };
      operations.push(operation);
      currentOperation = operation;
      applyPending(operation);
      continue;
    }

    const statusMatch = line.match(/^      x-dis-status:\s*([A-Za-z0-9_-]+)\s*$/);
    if (statusMatch) {
      const value = scalar(statusMatch[1]);
      if (currentOperation) currentOperation.status = value;
      else pendingStatus = value;
      continue;
    }

    const permissionsMatch = line.match(/^      x-dis-permissions:\s*(\[.*\])\s*$/);
    if (permissionsMatch) {
      const value = inlineList(permissionsMatch[1]);
      if (currentOperation) currentOperation.permissions = value;
      else pendingPermissions = value;
      continue;
    }

    const errorCodesMatch = line.match(/^      x-dis-error-codes:\s*(\[.*\])\s*$/);
    if (errorCodesMatch) {
      const value = inlineList(errorCodesMatch[1]);
      if (currentOperation) currentOperation.errorCodes = value;
      else pendingErrorCodes = value;
      continue;
    }

    const idempotencyMatch = line.match(/^      x-dis-idempotency:\s*([A-Za-z0-9_-]+)\s*$/);
    if (idempotencyMatch) {
      const value = scalar(idempotencyMatch[1]);
      if (currentOperation) currentOperation.idempotency = value;
      else pendingIdempotency = value;
      continue;
    }

    const apiVersionMatch = line.match(/^      x-dis-api-version:\s*([A-Za-z0-9_.-]+)\s*$/);
    if (apiVersionMatch) {
      const value = scalar(apiVersionMatch[1]);
      if (currentOperation) currentOperation.apiVersion = value;
      else pendingApiVersion = value;
      continue;
    }

    const compatibilityMatch = line.match(/^      x-dis-compatibility:\s*(.+?)\s*$/);
    if (compatibilityMatch) {
      const value = scalar(compatibilityMatch[1]);
      if (currentOperation) currentOperation.compatibility = value;
      else pendingCompatibility = value;
      continue;
    }

    const eventsMatch = line.match(/^      x-dis-events:\s*(\[.*\])\s*$/);
    if (eventsMatch) {
      const value = inlineList(eventsMatch[1]);
      if (currentOperation) currentOperation.events = value;
      else pendingEvents = value;
    }
  }

  return operations;
}

export function parseEndpointInventory(yamlText) {
  const endpoints = [];
  let current = null;
  for (const line of yamlText.split(/\r?\n/)) {
    const methodMatch = line.match(/^\s*-\s*method:\s*([A-Z]+)\s*$/);
    if (methodMatch) {
      if (current) endpoints.push(current);
      current = {
        method: methodMatch[1],
        path: "",
        operationId: "",
        auth: "",
        owner: "",
        status: "active",
        contractCard: null
      };
      continue;
    }
    if (!current) continue;
    const pathMatch = line.match(/^\s*path:\s*(\/[^\s]*)\s*$/);
    if (pathMatch) current.path = pathMatch[1];
    const operationMatch = line.match(/^\s*operationId:\s*([A-Za-z0-9_]+)\s*$/);
    if (operationMatch) current.operationId = operationMatch[1];
    const authMatch = line.match(/^\s*auth:\s*([A-Za-z0-9_]+)\s*$/);
    if (authMatch) current.auth = authMatch[1];
    const ownerMatch = line.match(/^\s*owner:\s*([A-Za-z0-9_-]+)\s*$/);
    if (ownerMatch) current.owner = ownerMatch[1];
    const statusMatch = line.match(/^\s*status:\s*([A-Za-z0-9_-]+)\s*$/);
    if (statusMatch) current.status = scalar(statusMatch[1]);
    const cardMatch = line.match(/^\s*contract_card:\s*([A-Za-z0-9_-]+)\s*$/);
    if (cardMatch) current.contractCard = scalar(cardMatch[1]);
  }
  if (current) endpoints.push(current);
  return endpoints;
}

export function partitionByStatus(routes) {
  const partitions = { active: [], planned: [], reserved: [], unknown: [] };
  for (const route of routes) {
    const status = route.status || "active";
    if (partitions[status]) partitions[status].push(route);
    else partitions.unknown.push(route);
  }
  return partitions;
}

export function sortedOperationIds(routes) {
  return routes.map((route) => route.operationId).sort();
}

export function byRouteKey(routes) {
  const out = new Map();
  for (const route of routes) {
    const key = routeKey(route);
    if (out.has(key)) throw new Error("duplicate route key: " + key);
    out.set(key, route);
  }
  return out;
}
