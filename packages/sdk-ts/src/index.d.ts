export interface CloudEnvelope<T = unknown> {
  status: number;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  meta: {
    request_id: string;
    api_version: string;
    next_cursor: string | null;
  };
}

export declare class CampusCloudClient {
  constructor(options: { baseUrl: string; accessToken?: string | null; fetchImpl?: typeof fetch });
  setAccessToken(token: string | null): void;
  request<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      idempotencyKey?: string | null;
    }
  ): Promise<CloudEnvelope<T>>;
  getHealth(): Promise<CloudEnvelope>;
  startOidcLogin(payload: Record<string, unknown>): Promise<CloudEnvelope>;
  exchangeAppTicket(payload: Record<string, unknown>): Promise<CloudEnvelope>;
  getWalletSummary(): Promise<CloudEnvelope>;
  createReservationPlan(payload: Record<string, unknown>, idempotencyKey: string): Promise<CloudEnvelope>;
  /** Unsupported: orders are created only by execution; throws. */
  createReservationOrder(...args: unknown[]): never;
  listReservationOrders(): Promise<CloudEnvelope<{ orders: Array<{ id: string; [key: string]: unknown }> }>>;
  getReservationOrder(orderId: string): Promise<CloudEnvelope>;
  listParcels(): Promise<CloudEnvelope>;
  upsertParcel(payload: Record<string, unknown>): Promise<CloudEnvelope>;
  listPlugins(): Promise<CloudEnvelope>;
}
