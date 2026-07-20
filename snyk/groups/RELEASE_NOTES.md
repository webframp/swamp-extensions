## 2026.07.20.2

**Fixed:** The `create_group_export` method wrote its resource under the spec
name `create_group_export`, but the resource schema is registered under the
noun-only key `group_export`. The write therefore targeted an undeclared
resource spec. The method now writes to the declared `group_export` spec.

**Upgrade note:** Data from `create_group_export` is now written under the
`group_export` resource spec instead of `create_group_export`. Queries or stored
resources keyed on the old spec name should be updated.
