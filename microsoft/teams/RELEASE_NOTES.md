## 2026.08.21.2

**Changed:**

- `list_channels`, `channel_messages`, and `chat_messages` now reject an
  empty `teamId`, `channelId`, or `chatId` with a clear validation error
  before calling the Graph API, instead of sending an empty ID and letting
  Graph return an opaque 404/400 deep in the call chain.
- Every Graph API call that lists or fetches teams, channels, chats, and
  messages (`list_teams`, `list_channels`, `channel_messages`, `list_chats`,
  `chat_messages`, and `attention`) now reports failures with the operation
  attempted and the relevant team/channel/chat ID, instead of surfacing only
  the raw Graph error status/code. The underlying `GraphApiError` is
  preserved as the error's `cause` for callers that need the original status
  code.
