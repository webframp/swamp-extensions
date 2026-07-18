## 2026.07.18.1

**Changed:** Version bump only, no code changes.

## 2026.06.26.1

**Changed:** Audit reports now include cache hit-rate and security event findings that were
previously missing. The underlying cloudflare extension's GraphQL methods were silently
failing — now that they work, the audit report produces complete results.

**Upgrade note:** Requires `@webframp/cloudflare@2026.06.26.1`. Pull both extensions together:
```
swamp extension pull @webframp/cloudflare
swamp extension pull @webframp/cloudflare-audit
```
