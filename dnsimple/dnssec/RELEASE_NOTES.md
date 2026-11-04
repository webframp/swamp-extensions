## 2026.11.03.4

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.11.03.3

Fixed: a delegation signer record, named from a domain and a record ID, could
share a name with a result named from one value. Those names now end in a
16-character hash, for example example.com-12345-<hash>. Results stored under
the old name stay where they are and are not updated.

Changed: the bundled API helper gained a function that reports truncation for
single-request lists. No method in this extension uses it, so nothing else
behaves differently.
