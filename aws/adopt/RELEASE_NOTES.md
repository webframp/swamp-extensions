## 2026.07.26.1

**Fixed:** Model failed to load because the upgrades array's last `toVersion`
("2026.07.18.2") did not match the model's current version ("2026.07.24.1").
Swamp's model loader enforces this invariant, causing the extension to be
rejected at load time before any AWS API calls could execute. This manifested
as silent failures in ECS Fargate environments where the error was not surfaced
to the operator.

**Upgrade note:** Users on 2026.07.24.1 can upgrade in place. The upgrade chain
now covers all published versions (2026.07.18.2 → 2026.07.24.1 → 2026.07.26.1)
with no schema changes at any step.
