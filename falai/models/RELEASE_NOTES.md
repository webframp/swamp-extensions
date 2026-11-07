## 2026.11.06.1

Regenerated from the current fal.ai OpenAPI spec. The model/endpoint schema
gains two new optional nullable fields: `retires_at` (ISO8601 timestamp when a
public endpoint is removed and stops accepting requests) and `replacement`
(endpoint ID of the public model to migrate to before retirement, or null). Both
are additive and nullable, so existing stored resources continue to validate
with no migration required.
