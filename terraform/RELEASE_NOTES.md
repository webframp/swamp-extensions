## 2026.10.21.1

**Fixed:** `read_state` wrote every resource attribute verbatim, so database
passwords, private keys and other attributes Terraform marks sensitive landed in
swamp data in plaintext. It now applies the state's `sensitive_values` and
replaces each sensitive attribute (or whole sensitive block) with
`***SENSITIVE***`, matching how `get_outputs` already treats sensitive outputs.

**Changed:** `tf_resource` data written by `read_state` no longer contains the
values of sensitive attributes. Workflows or reports that read those values from
swamp data now see `***SENSITIVE***`. A wholly sensitive map, list or block (for
example tags built with `merge()` over a sensitive variable) becomes the string
`***SENSITIVE***`, not a map or list, so consumers that iterate it must check
its type. Non-sensitive attributes are unchanged.

**Added:** `read_state` logs a warning naming every resource whose state lacks
`sensitive_values`. Terraform before 0.15 does not record it, so those resources
are written unmasked.

**Upgrade note:** Pull `@webframp/aws/terraform-drift` 2026.10.21.1 alongside
this version; earlier drift reports misread masked attributes as drift. No
schema change. Existing `tf_resource` data written by earlier versions still
holds plaintext sensitive attributes; re-run `read_state` to overwrite it, and
delete older data versions if they must not be retained.
