import { createSystemRoutes } from "./system.mjs";
import { createAuthRoutes } from "./auth.mjs";
import { createMeRoutes } from "./me.mjs";
import { createSchoolRoutes } from "./school.mjs";
import { createReservationsRoutes } from "./reservations.mjs";
import { createNotificationsRoutes } from "./notifications.mjs";
import { createParcelsRoutes } from "./parcels.mjs";
import { createPluginsRoutes } from "./plugins.mjs";
import { createAdminRoutes } from "./admin.mjs";
import { createSyncRoutes } from "./sync.mjs";
import { createCampusContentRoutes } from "./campus-content.mjs";
import { createMomentsExtensionRoutes } from "./moments.mjs";

export function createCoreRoutes(ctx) {
  return [
    ...createSystemRoutes(ctx),
    ...createAuthRoutes(ctx),
    ...createMeRoutes(ctx),
    ...createSchoolRoutes(ctx),
    ...createReservationsRoutes(ctx),
    ...createNotificationsRoutes(ctx),
    ...createParcelsRoutes(ctx),
    ...createPluginsRoutes(ctx),
    ...createAdminRoutes(ctx),
    ...createSyncRoutes(ctx),
    ...createCampusContentRoutes(ctx)
  ];
}

export function createExtensionRoutes(ctx) {
  return [...createMomentsExtensionRoutes(ctx)];
}
