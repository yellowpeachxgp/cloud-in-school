import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import {
  loadEndpointInventory,
  loadOpenApiText
} from "../packages/contracts/src/index.mjs";
import { CONSOLE_VIEWS, renderConsoleHtml } from "../apps/console/src/main.mjs";

test("Contract Parity: 100% bidirectional parity between registered HTTP routes, endpoint-inventory.yaml, and OpenAPI 3.1.2 spec", async () => {
  const app = createCampusCloudApp();
  const registered = app.getRegisteredRoutes();
  const inventory = loadEndpointInventory();
  const openApiText = loadOpenApiText();

  assert.equal(inventory.length, 66, "endpoint-inventory.yaml must declare 66 operations");
  assert.equal(registered.length, 66, "CampusCloudApp must register all 66 operations");

  const regByKey = new Map(registered.map((r) => [`${r.method} ${r.path}`, r]));
  const invByKey = new Map(inventory.map((e) => [`${e.method} ${e.path}`, e]));

  for (const [key, inv] of invByKey.entries()) {
    const reg = regByKey.get(key);
    assert.ok(reg, `Missing registered route for inventory entry: ${key}`);
    assert.equal(reg.operationId, inv.operationId, `operationId mismatch on ${key}`);
    assert.ok(
      openApiText.includes(`operationId: ${inv.operationId}`),
      `OpenAPI 3.1.2 spec missing operationId: ${inv.operationId}`
    );
  }

  for (const [key] of regByKey.entries()) {
    assert.ok(invByKey.has(key), `Uninventoried shadow route registered: ${key}`);
  }
});

test("Contract Parity: Operations Console exposes all 12 mandatory views", () => {
  assert.equal(CONSOLE_VIEWS.length, 12);
  const html = renderConsoleHtml();
  for (const view of CONSOLE_VIEWS) {
    assert.ok(html.includes(`id="view-${view.id}"`), `Missing console view ${view.id}`);
  }
});
