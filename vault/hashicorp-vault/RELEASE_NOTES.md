## 2026.07.30.1

**Added:** Documentation of empirically verified OTel trace safety properties.
The README now states that the no-token/no-body guarantee was confirmed against
swamp 20260725 + Deno 2.7.14, identifies the condition under which it could
break (Deno fetch auto-instrumentation activation), and links to the full probe
methodology in issue #276.

**Added:** Maintainer reference at `docs/otel_verification.md` covering the
probe environment, results, residual risks, and a re-verification schedule tied
to swamp runtime version bumps. This file is repo-only and does not ship with
the published extension.
