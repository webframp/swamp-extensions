## 2026.10.14.2

**Fixed:** The three bulk signal methods (assignee, state, update) now accept an
`entries` array (up to 199 signals) and send it as the `data` payload. They
previously sent an empty `{data: {attributes: {}}}` body and could not change
any signal.

**Upgrade note:** Arguments changed from none to a required `entries` array; no
resources or schemas changed.
