## 2026.11.03.4

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.11.03.3

Fixed: create_primary_server sends port as an integer. The argument was typed as
a string although DNSimple returns the port as an integer, so the request
carried a string the API can refuse. Pass a number, for example 53.

Changed: the bundled API helper now always hashes names built from two values.
No method in this extension builds one, so nothing else behaves differently.
