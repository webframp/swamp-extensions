## 2026.08.26.1

**Fixed:** Added missing `description` field to upgrade entry for version
2026.08.24.2. The omission caused `swamp extension pull` to fail with a catalog
validation error ("upgrades.N.description: Invalid input: expected string,
received undefined").
