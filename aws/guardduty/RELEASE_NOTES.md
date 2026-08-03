## 2026.08.02.1

**Changed:** Bump @aws-sdk/* 3.1100.0 → 3.1101.0 (2 packages)

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.30.2`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.30.2`.

## 2026.07.31.1

**Changed:** Bump @aws-sdk/* 3.1096.0 → 3.1100.0 (2 packages)

## 2026.07.30.2

**Added:** Pre-flight check with actionable error message when no GuardDuty detector
exists. The error now names the region, explains that GuardDuty must be enabled, and
provides the exact swamp commands to create a detector via `@swamp/aws/guardduty/detector`.

**Changed:** Extension description and README clarify that this is a read-only
observability model. A new Prerequisites section documents the detector requirement
and links to the infrastructure model for setup.
