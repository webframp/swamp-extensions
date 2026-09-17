## 2026.09.17.1

BREAKING: fal.ai removed the create_compute_instance operation (POST
/compute/instances) — instances can no longer be created through this API. Add
get_compute_instance (GET /compute/instances/{id}). Callers relying on
create_compute_instance must provision instances another way; there is no
in-place migration for this removal.
