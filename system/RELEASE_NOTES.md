## 2026.08.24.5

**Added:** `list_services` method — enumerate systemd service units filtered by
active state (active/inactive/failed) and unit type (service/timer/socket/mount).

**Added:** `list_ports` method — list TCP ports in LISTEN state with their owning
process name and PID via `ss -tlnp`.

**Added:** `search_processes` method — filter running processes by command name
substring, minimum %CPU threshold, and/or minimum %MEM threshold. Returns
matching processes sorted by CPU usage.

**Added:** Three new resource specs: `services`, `listening_ports`, and
`search_results` to store output from the new methods.
