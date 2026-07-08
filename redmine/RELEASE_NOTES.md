## 2026.07.08.1

**Released:** publishes the model-version load fix from #191.

That PR corrected the `redmine.ts` model version to match the manifest, but it
changed only the model source — not `manifest.yaml` — so the publish workflow
(which detects extensions by a changed `manifest.yaml`) never released it. This
version bump touches the manifest so the fix reaches the registry. No behaviour
change beyond #191.
