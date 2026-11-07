import test from "node:test";
import assert from "node:assert/strict";
import { createCampusCloudApp } from "../apps/api/src/app.mjs";
import {
  loadEndpointInventory,
  loadOpenApiText
} from "../packages/contracts/src/index.mjs";
import { CONSOLE_VIEWS, renderConsoleHtml } from "../apps/console/src/main.mjs";

test("Contract Parity: 100% bidirectional parity between registered HTTP routes, endpoint-inventory.yaml, and OpenAPI 3.1.2 spec", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  const registered = app.getRegisteredRoutes();
  const inventory = loadEndpointInventory();
  const openApiText = loadOpenApiText();

  assert.equal(inventory.length, 88, "endpoint-inventory.yaml must declare 88 operations");
  assert.equal(registered.length, 88, "CampusCloudApp must register all 88 operations");

  const regByKey = new Map(registered.map((r) => [`${r.method} ${r.path}`, r]));
  const invByKey = new Map(inventory.map((e) => [`${e.method} ${e.path}`, e]));

  for (const [key, inv] of invByKey.entries()) {
    const reg = regByKey.get(key);
    assert.ok(reg, `Missing registered route for inventory entry: ${key}`);
    assert.equal(reg.operationId, inv.operationId, `operationId mismatch on ${key}`);
    assert.equal(reg.auth, inv.auth, `auth mode mismatch on ${key} (${reg.operationId})`);
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

test("UI SDK & Pricing Parity: Unified XPeach Web UI SDK, Liquid Glass mode, /community route, and 1 🍑 pricing", async () => {
  const app = createCampusCloudApp({ requireAdminAccess: false });
  assert.equal(app.store.pricingMicropeach, 10_000, "Default reservation price must be 10,000 micropeach (1 🍑)");

  const cssRes = await app.inject({ method: "GET", url: "/static/xpeach-sdk.css" });
  assert.equal(cssRes.status, 200);
  assert.ok(String(cssRes.rawBody).includes("--xp-radius-card"));
  assert.ok(String(cssRes.rawBody).includes("liquid-glass"));

  const user = app.store.findOrCreateCloudUser({
    issuer: "https://sso.xpeach.codes",
    subject: "856f-cf51-b064-5d84",
    username: "yellowpeach",
    role: "admin"
  });
  const session = app.identity.issueDeviceSession(user, "contract-fixture");
  const cookieVal = app.identity.signWebSessionCookie({
    cloudUserId: user.id,
    accessToken: session.access_token,
    refreshToken: session.refresh_token
  });
  const commRes = await app.inject({
    method: "GET",
    url: "/community",
    headers: { cookie: `dis_web_session=${encodeURIComponent(cookieVal)}` }
  });
  assert.equal(commRes.status, 200);
  assert.ok(commRes.rawBody.includes("炽夜空动漫社"));
  assert.ok(commRes.rawBody.includes("硬件技术联盟"));
  assert.ok(commRes.rawBody.includes("计算机服务社"));
  assert.ok(commRes.rawBody.includes("xp-entity-header"));
  assert.ok(!commRes.rawBody.includes("0.1 🍑"));
});
