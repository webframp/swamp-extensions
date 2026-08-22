## 2026.08.21.1

**Changed:** The health report no longer silently drops a check when its
underlying probe or diagnostic data can't be read. Previously, if the data
repository lookup failed or returned bytes that weren't valid JSON, the
report quietly treated the check as if it never ran (no finding, no
explanation). Both failure modes are now logged with the model/data target
and the underlying error, so a missing section in the report can be traced
back to a data-access or parsing problem instead of looking like a step that
simply didn't execute.
