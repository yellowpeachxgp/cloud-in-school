export class CampusCloudClient {
  constructor({ baseUrl, accessToken = null, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '').replace(/\/api$/, '');
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  setAccessToken(token) {
    this.accessToken = token;
  }

  async request(method, path, { body = undefined, headers = {}, idempotencyKey = null } = {}) {
    const reqHeaders = {
      Accept: 'application/json',
      ...headers
    };
    if (this.accessToken) {
      reqHeaders.Authorization = `Bearer ${this.accessToken}`;
    }
    if (idempotencyKey) {
      reqHeaders['Idempotency-Key'] = idempotencyKey;
    }
    if (body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json();
    return { status: res.status, ...json };
  }

  getHealth() {
    return this.request('GET', '/healthz');
  }

  startOidcLogin(payload) {
    return this.request('POST', '/api/v1/auth/mobile/start', { body: payload });
  }

  exchangeAppTicket(payload) {
    return this.request('POST', '/api/v1/auth/mobile/exchange', { body: payload });
  }

  getWalletSummary() {
    return this.request('GET', '/api/v1/me/wallet');
  }

  createReservationPlan(payload, idempotencyKey) {
    return this.request('POST', '/api/v1/reservation-plans', { body: payload, idempotencyKey });
  }

  listReservationOrders() {
    return this.request('GET', '/api/v1/me/orders');
  }

  // An order is produced by confirmed execution, not created by a client.
  // Do not silently reinterpret a monetary API as a booking action.
  createReservationOrder() {
    throw new Error('Unsupported operation: use createReservationPlan with explicit price acceptance');
  }

  async getReservationOrder(orderId) {
    const result = await this.listReservationOrders();
    if (!result.ok) return result;
    const order = result.data?.orders?.find((item) => item.id === orderId);
    if (order) return { ...result, data: order };
    return { ...result, status: 404, ok: false, data: undefined,
      error: { code: 'NOT_FOUND', message: 'Order not found', retryable: false } };
  }

  listParcels() {
    return this.request('GET', '/api/v1/parcels');
  }

  upsertParcel(payload) {
    return this.request('POST', '/api/v1/parcels/imports', { body: payload });
  }

  listPlugins() {
    return this.request('GET', '/api/v1/plugins/registry');
  }
}
