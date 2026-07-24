## 2026.07.24.1

**Breaking (schema):** GSI key structure redesigned for per-model partitioning.

- `gsi1pk` changes from the constant `"FILE"` to `"FILE#<modelType>/<modelId>"`
  for model data and `"FILE#_system/<subdir>"` for system data.
- `gsi1sk` changes from bare `relPath` to `"<updatedAt>|<relPath>"` enabling
  time-range key conditions at the DynamoDB storage layer.
- A `PARTITIONS#registry` item (StringSet) tracks all known model partitions
  for full-sync discovery.

**This is a schema-breaking change.** Existing DynamoDB tables with items written
under the old `gsi1pk = "FILE"` format will not be visible to the new query
logic. Since no production users exist on the old schema, no migration path is
provided. New tables work out of the box.

**Performance:** Sync operations now scale with change volume rather than total
item count. Scoped pull/push read only the affected model's GSI partition
(O(changed items)) instead of scanning all items (O(total items)).

**Changed:**
- Raise `DIRTY_PATHS_CAP` from 200 to 1000, deferring the `bulkInvalidated`
  full-scan trigger for repos with many models.
- Bump AWS SDK from 3.1091.0 to 3.1094.0 (patch-level update).
