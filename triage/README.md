# Cross-provider triage

`@webframp/triage` supplies deterministic URL authorization, context and assessment contracts, hash-bound action bundles, and explicit Sean-only approval bindings. It composes provider models and `@swamp/software-factory`; it never writes remotely itself.

```bash
swamp model create @webframp/triage triage --global-arg-file triage.yaml
swamp model method run triage parse_target --input url=https://github.com/webframp/swamp-extensions/issues/1
```

Use the included workflows to record the current factory stage and route a persisted, hash-approved action to its typed provider model. The action workflows accept only a `bundle_hash` and `action_id`; they first load the saved assessment, exact bundle, and Sean approval binding through `triage`, then pass the released provider method and payload through CEL. Caller-supplied action payloads are never dispatched.

The instance configuration defines allowed targets and bounded-review limits; no target allowlist is hardcoded.

```bash
swamp workflow validate @webframp/triage-intake
swamp workflow run @webframp/triage-intake --input triage_model=triage --input factory_model=factory --input work_item=https://github.com/webframp/swamp-extensions/issues/1 --input url=https://github.com/webframp/swamp-extensions/issues/1
```
