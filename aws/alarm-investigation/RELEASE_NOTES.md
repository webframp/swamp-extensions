## 2026.08.23.1

**Changed:** Documentation only — no code changes. Documented the previously
undocumented `profile` global arg for SSO/`fromIni` auth. Added a
`## Troubleshooting` section covering `enrichAlarm`'s per-alarm degrade to
`verdict: "unknown"`, the silent empty `sns_topics` catch in `resolveSnsTopics`,
`getRecentMetricStats`'s silent `null` return for composite/anomaly-detection
alarms, and the unpaginated 100-record cap on noisy-alarm counts.
