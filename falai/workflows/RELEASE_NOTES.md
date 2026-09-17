## 2026.09.17.1

Response schema fields are now generated as optional/nullable-optional
regardless of the spec's required list, so reading a resource stored under an
older model version no longer throws Required when the live API adds a new
required field. No API surface change for this extension.
