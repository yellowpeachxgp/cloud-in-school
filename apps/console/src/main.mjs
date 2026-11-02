import http from "node:http";

export const CONSOLE_VIEWS = Object.freeze([
  { id: "overview", title: "1. 全局系统与服务健康总览 (System Overview)" },
  { id: "schools", title: "2. 学校接入、能力状态与授权证据 (School Integrations)" },
  { id: "kill-switch", title: "3. 紧急熔断开关与降级策略 (Kill-Switch Control)" },
  { id: "triple-schedule", title: "4. ADR-005 三阶段调度监控 (T-30m / T-5m / T Queue)" },
  { id: "reservation-jobs", title: "5. 预约任务执行与权威回读核验 (Reservation Jobs)" },
  { id: "orders-ledger", title: "6. 订单与 🍑 钱包账务流水 (Orders & Peach Ledger)" },
  { id: "reconciliation", title: "7. 异常订单对账与 PAYMENT_DUE 追缴 (Reconciliation)" },
  { id: "refund-approvals", title: "8. 双人复核退款审批台 (Dual-Person Refund Approvals)" },
  { id: "parcel-governance", title: "9. Parcel Hub 来源授权矩阵治理 (Parcel Provider Matrix)" },
  { id: "plugin-registry", title: "10. 插件签名与权限审计台 (Signed Plugin Registry)" },
  { id: "kms-vault", title: "11. KMS 信封加密与密钥轮换状态 (KMS Envelope Vault)" },
  { id: "audit-trail", title: "12. 全链路安全与红队审计日志 (Immutable Security Audit Trail)" }
]);

export function renderConsoleHtml() {
  const cards = CONSOLE_VIEWS.map(
    (v) => `<section class="card" id="view-${v.id}"><h2>${v.title}</h2><p>Status: Active & Enforced</p></section>`
  ).join("\n");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Day in School — Campus Cloud 运营与安全控制台</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f172a; color: #f8fafc; }
    h1 { color: #38bdf8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1rem; }
  </style>
</head>
<body>
  <h1>Day in School — Campus Cloud Operations Console (v4 Argon)</h1>
  <div class="grid">${cards}</div>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CONSOLE_PORT || 8081);
  const host = process.env.HOST || "127.0.0.1";
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ops-console", views: CONSOLE_VIEWS.length }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderConsoleHtml());
  });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ service: "ops-console", host, port, views: CONSOLE_VIEWS.length }));
  });
}
