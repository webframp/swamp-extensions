## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added the missing Anthropic/Claude
Enterprise Analytics provider to the README's intro and Quick Start (it was already
in the `PROVIDERS` registry but undocumented). Expanded the `status` and `generate`
method descriptions with concrete command examples, and added a `## Troubleshooting`
section covering the "unconfigured" vs. genuine-failure ambiguity in
`fetchLatestScanData`, and the silent zero-fallbacks in `numField()` that can mask
upstream schema drift.
