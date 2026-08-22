## 2026.08.21.2

**Changed:** CLI failures from `runTfCommand` now say what was being run and
where. Previously, if `terraform`/`tofu` couldn't be spawned at all (not
installed, not on `PATH`), the raw OS error propagated alone with no
indication of the command or working directory involved. A non-zero exit now
reports the exit code alongside stderr, and unparseable JSON output from
`show -json` is now reported as a JSON-parse failure naming the command and
working directory, instead of a bare `SyntaxError`.

## 2026.08.21.1

**Changed:** Tightened `workDir` on the global-args schema to require a
non-empty string. It's a required filesystem path the CLI shells out
against — an empty value never resolved to a usable Terraform/OpenTofu
working directory, so this catches misconfiguration at model-create time.

## 2026.08.20.1

**Upgrade note:** Bumped zod from 4.3.6 to 4.4.3. No behavioral changes — dependency version alignment only.
