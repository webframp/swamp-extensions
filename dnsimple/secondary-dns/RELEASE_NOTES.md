## 2026.11.03.2

Fixed: create_primary_server sends port as an integer. The argument was typed as
a string although DNSimple returns the port as an integer, so the request
carried a string the API can refuse. Pass a number, for example 53.
