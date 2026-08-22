## 2026.08.21.2

**Changed:** The unified report's provider-coverage lookup used to swallow lookup
failures silently — a provider was marked "Not configured" with no indication of
whether it was truly unconfigured or the underlying `findBySpec` call failed
(network error, malformed data, etc.). It now logs a warning naming the provider,
model instance, resource spec, and the underlying error message before falling
back to "Not configured," so a scan outage is distinguishable from a provider
that was never set up.
