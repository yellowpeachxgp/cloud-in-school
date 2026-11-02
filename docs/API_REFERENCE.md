# Campus Cloud OpenAPI 3.1.2 Reference

- Canonical OpenAPI 3.1.2 Specification: [`contracts/openapi/cloud-v1.yaml`](../contracts/openapi/cloud-v1.yaml)
- Endpoint Inventory (66 Operations): [`contracts/endpoints/endpoint-inventory.yaml`](../contracts/endpoints/endpoint-inventory.yaml)
- Error Catalog: [`contracts/errors/error-catalog.yaml`](../contracts/errors/error-catalog.yaml)
- HTTP Examples: [`contracts/examples/cloud-api-examples.http`](../contracts/examples/cloud-api-examples.http)

## Standard Response Envelope

Every HTTP response includes `X-Request-Id` and returns:

```json
{
  "ok": true,
  "code": "RESERVATION_PLAN_CREATED",
  "request_id": "req_...",
  "data": {},
  "meta": {
    "request_id": "req_...",
    "api_version": "v1",
    "next_cursor": null
  }
}
```
