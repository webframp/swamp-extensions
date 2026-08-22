## 2026.08.21.1

**Fixed:** The step-data loader silently swallowed failures when both the
primary and fallback `dataRepository.getContent` calls failed for a step
(empty catch block, no diagnostic). It now logs which step, model, and data
name failed to load along with both underlying error messages, so a missing
or malformed step output is visible in the report run's logs instead of
silently producing a `null` and an unexplained "no data available" finding.

**Upgrade note:** No change to the report's output shape or findings logic —
only added diagnostic logging on the failure path.
