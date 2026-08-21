## 2026.08.21.1

**Changed:** Tightened `workDir` on the global-args schema to require a
non-empty string. It's a required filesystem path the CLI shells out
against — an empty value never resolved to a usable Terraform/OpenTofu
working directory, so this catches misconfiguration at model-create time.

## 2026.08.20.1

**Upgrade note:** Bumped zod from 4.3.6 to 4.4.3. No behavioral changes — dependency version alignment only.
