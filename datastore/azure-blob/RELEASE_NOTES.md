## 2026.11.16.1

**Fixed:** A full (unscoped) pull crashed with
`RangeError: Maximum call stack size exceeded` once the datastore held enough
records (roughly 120,000 index entries). The pull spread every index entry into
a single `push()` call, which overflows V8's argument limit. Entries are now
added one at a time, so full syncs and `swamp workflow evaluate` work on large
datastores. Scoped pulls were not affected. The shard listing used the same
pattern and was changed too. Reported by @NeilHanlon in #566.
