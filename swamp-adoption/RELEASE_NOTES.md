## 2026.08.21.1

**Changed:** Added `.describe()` to previously undocumented fields on the
`InteractionSchema`, `SystemSchema`, `DataFlowSchema`, and `LandscapeSchema`
resource schemas (e.g. `verb`, `direction`, `frequency`, `pain`, `type`,
`from`, `to`, `manual`, `suggestedFirstExtension`). No behavioral change.

## 2026.08.01.1

**Added:** New `import_skill` method. If you already have a skill (`SKILL.md`
or similar agent instructions) that you're trying to formalize into a swamp
extension, this method converts it directly — seeding both `landscape` and
`extensionDesign` from the skill's structure instead of running a full systems
interview. `scaffold` and `next` work unchanged from either path.

**Changed:** `discover`'s interview now opens with a phase 0 question asking
whether you have an existing skill to convert. Answering yes routes to
`import_skill` and skips the systems interview; answering no continues as
before. Existing `discover` behavior for users starting from scratch is
unchanged.

**Fixed:** `scaffold` no longer splices the extension design's `name` field
into generated files unescaped. A design name containing a newline or a
double quote (reachable via `design`'s free-text `system` argument, and now
also via `import_skill`'s skill-path-derived name) could break out of the
quoted `name:` line in the generated `manifest.yaml` and inject arbitrary
YAML, or break the generated `mod.ts`/`mod_test.ts` string literals. The name
is now sanitized the same way the description field already was.

**Upgrade note:** No `globalArguments` changes — this is an additive method
only. Existing `adoption` model instances upgrade with a no-op transform.
