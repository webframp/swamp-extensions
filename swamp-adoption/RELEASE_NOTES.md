## 2026.07.26.1

**Changed:** Extensions scaffolded by this model now pin
`@systeminit/swamp-testing` at `0.20260604.20`, the current release, instead of
`0.20260504.10`. The old pin was hard-coded in the generated `deno.json`, so every
extension created through the adoption workflow started life on a test library
that was three releases behind and inconsistent with the rest of the repo.

**Upgrade note:** Nothing to do for extensions already scaffolded — they keep the
pin they were created with. Update their `deno.json` and regenerate `deno.lock`
with `deno install` if you want them on the current version.
