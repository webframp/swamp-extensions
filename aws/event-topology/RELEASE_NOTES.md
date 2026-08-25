## 2026.08.24.2

**Added:** `list_event_buses` method — enumerate EventBridge buses with the
number of rules on each. A lightweight alternative to `discover` when you only
need to know which buses exist and how many rules they carry, without
performing full topology graph construction.

**Added:** `event_buses` resource spec to store the bus listing output.
