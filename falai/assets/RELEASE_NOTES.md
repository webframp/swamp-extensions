## 2026.10.14.2

**Fixed:** `favorite_asset_collection` and `unfavorite_asset_collection` now
write one resource per `collection_id`, and `favorite_asset_character` and
`unfavorite_asset_character` one per `character_id`, instead of overwriting a
single `-current` instance.

**Upgrade note:** No methods or arguments changed. Data previously stored under
the old `-current` instance names is not moved; re-run the action to write the
new instance.
