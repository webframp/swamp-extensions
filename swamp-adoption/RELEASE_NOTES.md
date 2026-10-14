## 2026.10.14.1

**Fixed:** The scaffold method failed on current swamp with
`Data name 'latest' is reserved for internal use`.

**Changed:** The scaffold result is now written as `scaffold-current` instead of
`latest`. Anything that read `data.latest("<model>", "latest")` or queried
`name == "latest"` must use the new name.

**Upgrade note:** Data stored under `latest` is not migrated; re-run the method
to populate `scaffold-current`. No attribute schemas changed.
