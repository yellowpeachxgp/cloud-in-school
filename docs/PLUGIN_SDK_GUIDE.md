# Day in School Plugin SDK Guide (`dis-extension/v2`)

## CLI Usage (`dis-plugin`)

```bash
# 1. Scaffold a new signed plugin
npx dis-plugin init ./my-campus-plugin --id org.example.my-campus-plugin

# 2. Validate manifest schema, permissions, UI slots & artifact paths
npx dis-plugin validate ./my-campus-plugin

# 3. Sign manifest & compute SHA-256 digests of entry_artifacts
npx dis-plugin sign ./my-campus-plugin

# 4. Verify Ed25519 signature & SHA-256 digests
npx dis-plugin verify ./my-campus-plugin
```

## Supported UI Extension Slots

- `home.cards`
- `campus.services`
- `library.actions`
- `parcel.cards`
- `parcel.providers`
- `settings.entries`
