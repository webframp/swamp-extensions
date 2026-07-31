# OTel Trace Exposure Verification

Maintainer reference documenting the empirical verification of the extension's
trace safety properties. This file does not ship with the published extension.

Issue: https://github.com/webframp/swamp-extensions/issues/276

## Summary

The hashicorp-vault extension emits OpenTelemetry spans that carry vault name,
key name, and KV version. It never records secret values, tokens, or request
bodies. This document verifies that the *runtime environment* (swamp host + Deno)
does not independently capture those values via its own instrumentation.

## Test Environment

- swamp `20260725.210408.0-sha.6f10bd42`, Deno 2.7.14
- Mock Vault KV v2 on `127.0.0.1:8299`
- Local OTLP receiver on `127.0.0.1:4319` writing exported payloads to disk
- `OTEL_DENO=true OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4319`
- Three canaries: the Vault token, the secret value, and a marker attribute set
  by a probe span compiled into a scratch copy of the extension
- Command: `swamp vault put probe-vault probe/ext-span2 "<secret canary>"`

## Results

### 1. Extension spans export and nest correctly

A span created inside the bundled vault extension exports with its own
instrumentation scope and parents to the host's span:

```
swamp                        | swamp.cli               | id=35deb0cd... parent=-
swamp                        | swamp.vault.put         | id=0096b146... parent=35deb0cd...
@webframp/hashicorp-vault    | PROBE HashiCorp Vault put| id=b6f0bb8d... parent=0096b146...
```

The probe used `tracer.startSpan` (not `startActiveSpan`) and still picked up
`swamp.vault.put` as its parent. Ambient context propagates into the bundle, so
`withVaultSpan` nests without explicit context plumbing.

### 2. No fetch auto-instrumentation spans

The mock Vault logged both requests but neither produced an HTTP span in the
exported payloads. Deno's fetch auto-instrumentation is not active under swamp
in this build. Canary sweep:

| Canary         | Occurrences in exported payloads |
| -------------- | -------------------------------- |
| Vault token    | 0                                |
| Secret value   | 0                                |
| Probe marker   | 1 (the span that deliberately set it) |

### 3. Host redacts CLI arguments

`swamp vault put <vault> <key> <secret>` records:

```
swamp.args = "<REDACTED> <REDACTED> <REDACTED>"
```

Positional arguments are redacted wholesale. No need to duplicate this concern
at the extension level.

### 4. Host vault spans carry no attributes

`swamp.vault.put` exported with an empty attribute list. `vault.name` is not set
on the host span despite the string existing in the binary. The extension records
`vault.name` itself rather than assuming the parent has it.

## Residual Risks

Re-check these on swamp or Deno version bumps:

### Fetch auto-instrumentation activation

The binary already carries `deno.fetch`, `url.full`, `url.query`, and
`http.request.header.` prefixed keys. The machinery is present and merely
inactive. If enabled, `X-Vault-Token` becomes a span attribute on every request
this extension makes. Nothing in the extension can prevent that — it would
require swamp-level span filtering or Deno configuration to suppress header
capture.

**Trigger:** Any swamp release that bumps the Deno runtime version.

**Check:** Re-run the probe and search exported payloads for `X-Vault-Token`.

### Body content attributes

The binary has `http.request.body.size` and `http.response.body.size` but no
body-content attribute, consistent with OTel HTTP semantic conventions. Sizes are
harmless. A future deviation from semconv that adds body content capture would
expose secret values in `put` payloads.

**Trigger:** Unlikely absent a custom Deno instrumentation patch. Low priority.

### URL path exposure

If fetch spans appear, `url.full` includes the Vault path (e.g.,
`/v1/secret/data/my-app/db-password`). This exposes key names — the same
exposure as `vault.secret_key`, not a new one. Documented in the README as an
accepted trade-off.

### Coverage gaps

This probe tested `put` only. `get`, `list`, `read-secret`, `annotate`, and
`inspect` were not individually swept. The request shape is the same (`fetch`
with `X-Vault-Token` header), so the exposure surface is identical, but anyone
wanting audit-trail certainty should run the probe for each operation.

## Reproduction

The probe requires three components:

1. **OTLP sink** — A Deno script serving on port 4319 that writes every
   received payload to disk as JSON.
2. **Mock Vault** — A Deno script serving KV v2 endpoints on port 8299,
   logging all requests with their headers.
3. **Probe extension** — A copy of `hashicorp.ts` with an additional
   `tracer.startSpan("PROBE ...")` in the `put` method that sets a
   `probe.marker` attribute.

Each is approximately 40 lines. The method section above is the complete recipe.
Re-create them rather than relying on any `/tmp` artifacts surviving.

## Re-verification Schedule

Run this probe:
- On any swamp release that changes the Deno runtime version
- On any swamp release that mentions OTel, tracing, or instrumentation changes
- Before any change to this extension that adds new `fetch` calls or modifies
  request construction
