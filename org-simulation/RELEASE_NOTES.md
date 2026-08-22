## 2026.08.21.2

**Changed:**

- `design_topology` now rejects a topology with duplicate widget ids, with
  an error listing the offending id(s). Previously duplicate ids passed
  validation and silently collapsed to whichever widget was listed last
  once the simulation indexed widgets by id, producing a topology that
  simulated differently from the one you described.
