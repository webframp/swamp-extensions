## 2026.08.23.1

**Changed:** Documentation only — no code changes. Added usage examples for
`attention` with `mode=unread_only`, `list_chats` with `nameFilter`, and
`chat_messages` with `since`. Added a `## Troubleshooting` section covering
device-code expiry during `bootstrap`, `invalid_grant` as the one
recognizable OAuth error code from `refreshAccessToken` (vs. raw Graph codes
otherwise), the two independent sources of a `truncated: true` flag on
channel and chat listings, and `Authorization_RequestDenied` meaning missing
admin consent rather than a stale token.
