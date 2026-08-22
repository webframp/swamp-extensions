## 2026.08.21.1

**Changed:** Both reports' internal `getData` helper now logs the data path
and underlying error when a stored issue-list/issue-detail resource can't
be read or parsed, instead of silently treating a real read/parse failure
the same as a genuinely absent resource. The reports still degrade
gracefully (no throw) — this only makes an unexpected failure visible in
the workflow logs instead of masking it as "no data available."

## 2026.08.20.1

**Changed:** Bump @webframp/redmine 2026.08.14.1 → 2026.08.20.1

## 2026.08.15.1

**Changed:** Bump @webframp/redmine 2026.07.18.1 → 2026.08.14.1

## 2026.07.24.1

**Changed:** Bump dependency pin:
- @webframp/redmine 2026.07.09.1 → 2026.07.18.1
