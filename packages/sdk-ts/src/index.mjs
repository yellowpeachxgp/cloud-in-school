export class CampusCloudClient {
  constructor({ baseUrl, accessToken = null, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
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
    return this.request('GET', '/v1/health');
  }

  startOidcLogin(payload) {
    return this.request('POST', '/v1/auth/oidc/start', { body: payload });
  }

  exchangeAppTicket(payload) {
    return this.request('POST', '/v1/auth/oidc/exchange-ticket', { body: payload });
  }

  getWalletSummary() {
    return this.request('GET', '/v1/wallet/peach/summary');
  }

  createReservationOrder(payload, idempotencyKey) {
    return this.request('POST', '/v1/reservations/orders', { body: payload, idempotencyKey });
  }

  getReservationOrder(orderId) {
    return this.request('GET', `/v1/reservations/orders/${encodeURIComponent(orderId)}`);
  }

  listParcels() {
    return this.request('GET', '/v1/parcels');
  }

  upsertParcel(payload) {
    return this.request('POST', '/v1/parcels', { body: payload });
  }

  listPlugins() {
    return this.request('GET', '/v1/plugins/registry');
  }
}
