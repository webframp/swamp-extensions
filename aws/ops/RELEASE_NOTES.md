## 2026.08.21.1

**Changed:** `incident_report` and `morning_pulse_report` no longer swallow
filesystem errors silently when reading a step's data artifact. A missing
artifact (the normal case when a step didn't run) is still handled quietly,
but permission errors, I/O errors, and malformed JSON are now logged with the
artifact path and underlying error instead of disappearing into an empty
catch block — a corrupt or unreadable artifact used to look identical to
"no data available" in the generated report.

## 2026.08.20.1

**Changed:** Bump @webframp/aws/logs 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/metrics 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/alarms 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/traces 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/inventory 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/networking 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.13.1 → 2026.08.20.1

## 2026.08.15.1

**Changed:** Bump @webframp/aws/logs 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/metrics 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/alarms 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/traces 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/inventory 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/networking 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.02.1 → 2026.08.13.1

## 2026.08.05.1

**Changed:** Bump @webframp/aws/logs 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/metrics 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/alarms 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/traces 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/inventory 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/networking 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.08.01.1 → 2026.08.02.1

## 2026.08.02.1

**Changed:** Bump @webframp/aws/logs 2026.07.30.2 → 2026.08.01.1

**Changed:** Bump @webframp/aws/metrics 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/alarms 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/traces 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/inventory 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/networking 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.30.1 → 2026.08.01.1

## 2026.07.31.1

**Changed:** Bump @webframp/aws/logs 2026.07.24.1 → 2026.07.30.2

**Changed:** Bump @webframp/aws/metrics 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/alarms 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/traces 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/inventory 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/networking 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.07.24.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.24.1 → 2026.07.30.1

## 2026.07.27.1

**Changed:** Bump @webframp/aws/logs 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/metrics 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/alarms 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/traces 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/inventory 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/networking 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/alarm-investigation 2026.07.21.1 → 2026.07.24.1

**Changed:** Bump @webframp/aws/cost-explorer 2026.07.21.1 → 2026.07.24.1

## 2026.07.24.1

**Changed:** Bump dependency pins to latest published versions:
- @webframp/aws/logs 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/metrics 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/alarms 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/traces 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/inventory 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/networking 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/alarm-investigation 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/cost-explorer 2026.07.18.1 → 2026.07.21.1
- @webframp/github 2026.07.16.1 → 2026.07.18.1
