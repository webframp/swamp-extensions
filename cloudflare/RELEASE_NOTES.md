## 2026.07.13.1

**Changed:** Pinned the `zod` import specifier to `npm:zod@4.4.3` across all
model files (`zone`, `worker`, `waf`, `dns`, `cache`), matching the version used
by the rest of the repo. Previously these files pinned `4.3.6`. No API or
runtime behavior changes — `4.4.3` is a backward-compatible patch.
