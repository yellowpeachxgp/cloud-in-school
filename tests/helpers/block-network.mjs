// Preload for isolated verification. Only the local mock Redis TCP fixture is allowed.
import net from "node:net";
import tls from "node:tls";
const blocked = () => { throw new Error("External network is disabled in isolated tests"); };
globalThis.fetch = async () => blocked();
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  const host = typeof options === "object" ? options.host : typeof args[1] === "string" ? args[1] : "localhost";
  if (!["127.0.0.1", "::1", "localhost"].includes(host || "localhost")) return blocked();
  return originalConnect.apply(this, args);
};
tls.connect = blocked;
