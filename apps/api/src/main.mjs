import { createCampusCloudApp } from "./app.mjs";

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const app = createCampusCloudApp({
  storeOptions: {
    snapshotPath:
      process.env.CLOUD_SNAPSHOT_PATH || "/opt/cloud-in-school/.data/cloud-state.json"
  }
});
const server = app.createHttpServer();

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      service: "cloud-in-school-api",
      status: "listening",
      host,
      port,
      registered_operations: app.getRegisteredRoutes().length
    })
  );
});
