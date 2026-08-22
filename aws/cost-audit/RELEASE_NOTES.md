## 2026.08.21.1

**Changed:** The report's `getData` helper no longer treats every read/parse
failure as "no data available." A missing data artifact (the producing step
didn't run) still returns null silently, but a file-permission error or
malformed JSON now logs a message naming the artifact path and the
underlying error, instead of swallowing it and silently rendering the report
as if the data were absent.

## 2026.08.20.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.13.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/networking 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/inventory 2026.08.05.1 → 2026.08.20.1

## 2026.08.15.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.02.1 → 2026.08.13.1

**Changed:** Bump @webframp/aws/networking 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/inventory 2026.08.02.1 → 2026.08.05.1

## 2026.08.05.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/networking 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/inventory 2026.08.01.1 → 2026.08.02.1

## 2026.08.02.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/networking 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/inventory 2026.07.30.1 → 2026.08.01.1

## 2026.07.31.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/networking 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/inventory 2026.07.24.1 → 2026.07.30.1

## 2026.07.27.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/networking 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/inventory 2026.07.21.1 → 2026.07.24.1

## 2026.07.24.1

**Changed:** Bump dependency pins to latest published versions:
- @webframp/aws/cost-explorer 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/networking 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/inventory 2026.07.18.1 → 2026.07.21.1
