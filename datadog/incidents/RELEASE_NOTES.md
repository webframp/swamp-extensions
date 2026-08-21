## 2026.08.21.1

**Changed:** Schema-only tightening pass, no behavioral change.
- Added `.min(1)` to `apiKey`/`appKey` in the global arguments and to the
  required `incident_id`/`impact_id` UUID arguments across
  `list_incident_impacts`, `create_incident_impact`, and
  `delete_incident_impact`, so empty identifiers are rejected before
  making an API call.
- Added `.describe()` to the previously undocumented `fields` argument on
  `create_incident_impact`.
