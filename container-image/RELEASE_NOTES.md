## 2026.10.21.1

**Fixed:** The README logged in to ECR by exporting the password into a shell
variable and passing `--input password="$TOKEN"`, which records the password in
cleartext with the method run. It now passes
`--input 'password=${{ vault.get("ecr", "PASSWORD") }}'`, which swamp resolves
and redacts.

**Added:** A "Registry credentials" README section: an ECR password kept fresh
by a vault refresh hook
(`swamp vault put … --refresh-from 'aws ecr
get-login-password …'`), the ECR
credential helper as a password-free alternative, and an interactive
`swamp vault put` flow for GHCR, DockerHub and other registries.

**Changed:** The `login` `password` argument description says to supply it with
a `vault.get` expression.

**Upgrade note:** Documentation only; no behavioral or schema changes.
