## 2026.08.21.1

**Changed:** AWS API failures in `list_nat_gateways`, `list_load_balancers`,
`list_elastic_ips`, and `get_data_transfer_metrics` now say which resource
type and region were being queried instead of surfacing the raw SDK error,
with the original error preserved as the cause.

`get_data_transfer_metrics`'s `days` argument now requires an integer between
1 and 365 — previously a zero, negative, or absurdly large value would only
surface as a confusing CloudWatch time-range error deep inside the method.

No schema changes.
