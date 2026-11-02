import http from "node:http";
import { IsolatedFinanceBridge } from "../../../packages/finance/src/index.mjs";

export function createFinanceBridgeServer(options = {}) {
  const bridge = new IsolatedFinanceBridge(options);
  return http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "finance-bridge", hold_supported: false }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, code: "NOT_FOUND" }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FINANCE_BRIDGE_PORT || 8082);
  createFinanceBridgeServer().listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ service: "finance-bridge", port }));
  });
}
