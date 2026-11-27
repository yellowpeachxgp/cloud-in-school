import { route } from "./route-table.mjs";

export function createLedgerRoutes(ctx) {
  const { ledger } = ctx;
  return [
    route("POST", "/api/v1/groups/{groupId}/ledger/entries", "createLedgerEntry", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.createLedgerEntry(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/ledger/entries", "listLedgerEntries", "bearer", async ({ auth, params, query }) =>
      ledger.listLedgerEntries(auth, params, query)
    ),
    route("POST", "/api/v1/groups/{groupId}/ledger/entries/{entryId}/amend", "amendLedgerEntry", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.amendLedgerEntry(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/ledger/balances", "getLedgerBalances", "bearer", async ({ auth, params, nowMs }) =>
      ledger.getLedgerBalances(auth, params, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/settlements", "createSettlement", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.createSettlement(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/settlements", "listSettlements", "bearer", async ({ auth, params, query }) =>
      ledger.listSettlements(auth, params, query)
    ),
    route("GET", "/api/v1/settlements/{settlementId}", "getSettlement", "bearer", async ({ auth, params }) =>
      ledger.getSettlement(auth, params)
    ),
    route("POST", "/api/v1/settlements/{settlementId}/confirm", "confirmSettlement", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.confirmSettlement(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/settlements/{settlementId}/cancel", "cancelSettlement", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.cancelSettlement(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/rotas", "createDutyRota", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.createDutyRota(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/rotas", "listDutyRotas", "bearer", async ({ auth, params, query }) =>
      ledger.listDutyRotas(auth, params, query)
    ),
    route("GET", "/api/v1/rotas/{rotaId}", "getDutyRota", "bearer", async ({ auth, params }) =>
      ledger.getDutyRota(auth, params)
    ),
    route("PATCH", "/api/v1/rotas/{rotaId}", "updateDutyRota", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.updateDutyRota(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/duty-tasks", "listDutyTasks", "bearer", async ({ auth, params, query }) =>
      ledger.listDutyTasks(auth, params, query)
    ),
    route("POST", "/api/v1/duty-tasks/{taskId}/complete", "completeDutyTask", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.completeDutyTask(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/duty-tasks/{taskId}/confirm", "confirmDutyTaskCompletion", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.confirmDutyTaskCompletion(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/duty-tasks/{taskId}/skip", "skipDutyTask", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.skipDutyTask(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/rotas/{rotaId}/swaps", "requestDutySwap", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.requestDutySwap(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/rotas/{rotaId}/swaps", "listDutySwaps", "bearer", async ({ auth, params, query }) =>
      ledger.listDutySwaps(auth, params, query)
    ),
    route("GET", "/api/v1/duty-swaps/{swapId}", "getDutySwap", "bearer", async ({ auth, params }) =>
      ledger.getDutySwap(auth, params)
    ),
    route("POST", "/api/v1/duty-swaps/{swapId}/resolve", "resolveDutySwap", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.resolveDutySwap(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/groups/{groupId}/repairs", "createRepairTicket", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.createRepairTicket(auth, params, body, headers, nowMs)
    ),
    route("GET", "/api/v1/groups/{groupId}/repairs", "listRepairTickets", "bearer", async ({ auth, params, query }) =>
      ledger.listRepairTickets(auth, params, query)
    ),
    route("GET", "/api/v1/repairs/{repairId}", "getRepairTicket", "bearer", async ({ auth, params }) =>
      ledger.getRepairTicket(auth, params)
    ),
    route("PATCH", "/api/v1/repairs/{repairId}", "updateRepairTicket", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.updateRepairTicket(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/repairs/{repairId}/status", "transitionRepairStatus", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.transitionRepairStatus(auth, params, body, headers, nowMs)
    ),
    route("POST", "/api/v1/repairs/{repairId}/review", "submitRepairReview", "bearer", async ({ auth, params, body, headers, nowMs }) =>
      ledger.submitRepairReview(auth, params, body, headers, nowMs)
    )
  ];
}
