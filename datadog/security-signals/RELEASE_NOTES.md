## 2026.09.15.2

**Fixed:** A non-numeric `Retry-After` header on a 429 response (e.g. an
HTTP-date value) produced `NaN`, which fed into an unbounded `setTimeout`
delay on retry. Non-numeric values now fall back to the existing 5-second
default.

**Added:** `attributes` field on security signal list, search, and get
response schemas, returned when listing or searching signals (distinct from
`custom`, which is returned when retrieving a single signal).
