## 2026.09.10.4

**Fixed:**

- Resource instance names for get/update methods with two or more path
  parameters (e.g. `get_app_queue_info(owner, name)`,
  `get_workflow(username,
  workflow_name)`) were built by joining raw values
  with `"_"`. Two distinct owner/name pairs that split differently around an
  underscore (e.g. `"john"`/`"doe_app"` and `"john_doe"`/`"app"`) produced the
  identical instance name and collided. Multi-param instance names are now
  derived from a hash of the JSON-encoded parameter tuple, which delimits each
  part unambiguously.

**Upgrade note:** No schema changes. All fixes are internal to method execution;
existing stored resources are unaffected.
