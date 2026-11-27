# Plugin manifest shared contract fixtures

`valid/` and `invalid/` are the authoritative cross-runtime `dis-extension/v2` manifest fixtures for cloud plugin-sdk and Android. They were migrated from the W6-00 runtime mirror without changing fixture bytes.

Fixture names are machine-significant:

- `valid-*.json` must be accepted by the contract schema, cloud SDK validation, and Android `ExtensionManifestV2Codec`.
- `invalid-<runtime_validation_code>-*.json` must be rejected by both runtimes with the exact canonical runtime validation code encoded in the filename.

The current set contains 58 JSON fixtures (10 valid, 48 invalid), covering missing required fields, unknown fields, blank/nonblank display strings, legacy schema-version enum validation, unknown permissions and slots, non-HTTPS or path-bearing origins, Zip-Slip and unsafe artifact paths, invalid SHA-256 digests, malformed signatures, host API range/boundary failures, duplicate object keys, overlong number literals, decimal/exponential integer spellings, and `size_bytes` boundaries.
