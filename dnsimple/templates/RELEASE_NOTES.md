## 2026.11.03.3

Fixed: a result named from two path values, such as a record under a template,
could share a name with a result named from one value. Those names now end in a
16-character hash, for example 12-34-<hash>. Results stored under the old name
stay where they are and are not updated.

Changed: the bundled API helper gained a function that reports truncation for
single-request lists. No method in this extension uses it, so nothing else
behaves differently.
