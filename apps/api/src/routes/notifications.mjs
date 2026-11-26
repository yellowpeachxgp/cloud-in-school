import { route } from "./route-table.mjs";
import {
  ContractError
} from "../../../../packages/contracts/src/index.mjs";

export function createNotificationsRoutes(ctx) {
  const {
    store
  } = ctx;

  return [
  route("GET", "/api/v1/notifications", "listMyNotifications", "bearer", async ({ auth }) => {
    const notifications = store.recordsForUser("notifications", auth.cloudUserId);
    return { status: 200, code: "NOTIFICATIONS_LISTED", data: { notifications } };
  }),

  route(
    "POST",
    "/api/v1/notifications/{notificationId}/read",
    "markNotificationRead",
    "bearer",
    async ({ auth, params, nowMs }) => {
      const n = store.notifications.get(params.notificationId);
      if (!n || n.cloud_user_id !== auth.cloudUserId) {
        throw new ContractError("NOT_FOUND", "Notification not found");
      }
      n.read_at = new Date(nowMs).toISOString();
      return { status: 200, code: "NOTIFICATION_READ", data: n };
    }
  )
  ];
}
