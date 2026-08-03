## 2026.08.02.2

**Fixed:** The workflow's documentation comment told users to configure the
driver with `data.latest("agentcore-provisioner", "provision")`. That example
was wrong — the provisioner writes its resource under the instance name `"main"`
(via `writeResource("provision", "main", ...)`), and `data.latest()`'s second
argument matches the resource's instance name, not its spec name. Following the
old example would have produced `Invalid expression: No such key: attributes`.
The doc comment now reads `data.latest("agentcore-provisioner", "main")`.

**Upgrade note:** Documentation-only fix. No model, method, or schema change —
nothing to do on upgrade beyond re-reading the corrected example if you copied
the old one.
