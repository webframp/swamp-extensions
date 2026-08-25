## 2026.08.24.4

**Added:** `list_services` method — lightweight service enumeration from X-Ray
service graph data. Returns service name, type, account ID, request count,
fault/error/throttle counts, and average response time in milliseconds. A
faster alternative to `get_service_graph` when you only need to know which
services are active and their high-level health.

**Added:** `service_list` resource spec to store the lightweight service listing.
