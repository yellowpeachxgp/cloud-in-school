// Route table primitive for the Cloud API composition root.
// Keep the public shape exactly aligned with the W0-08 contract:
// { method, path, operationId, handler, auth }.
export function route(method, path, operationId, auth, handler) {
  return { method, path, operationId, handler, auth };
}
