## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.27.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.20.1`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.20.1`.

## 2026.07.27.1

**Changed:** Reformatted files that had drifted from `deno fmt`. No code
behavior changes.

**Upgrade note:** Tooling and formatting only. No model, method, schema, or
behavior change — nothing to do on upgrade.
