# Runtime plugin manifest test fixtures (not contract fixtures)

These files are W6-00 runtime conformance fixtures for the current snake_case
`dis-extension/v2` implementation. They are intentionally **outside** `contracts/**`:
CT-01 owns `contracts/**` during this slice, so they must not be presented as the
AC-02 `contracts/fixtures/plugins/` shared contract fixtures.

File names encode the expected result:

- `valid-*.json` must parse;
- `invalid-<runtime_validation_code>-*.json` must fail with that canonical code.

The cloud and Android copies must keep the same file names and byte-for-byte contents;
parity regressions are intentional test failures, not platform-specific expected results.

The manifest signature field is structurally validated here only. Cryptographic
signature verification remains the responsibility of the signed-package verifier.

Itemized contract debt for these transitional runtime facts is registered in the
cloud authority-side file packages/plugin-sdk/runtime/contract-debt.json. That
register is governance evidence only; it is not a contract and does not make these
files shared contract fixtures.
