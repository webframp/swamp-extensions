## 2026.08.24.3

**Fixed:** Added missing `description` field to the `2026.08.24.2` upgrade entry. The swamp binary's model loader requires `description: string` on every upgrade entry; the prior publish omitted it, causing a Zod validation error at load time.
