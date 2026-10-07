## 2026.10.07.1

**Added:** The model catalog list and search method (`get_models`) accepts an
optional `sort` argument, either `relevant` or `recent`. `recent` orders by
publication date and falls back to creation date. The default stays `relevant`,
so existing calls behave as before. fal.ai ignores `sort` when `endpoint_id` is
given and returns the models in the order requested.

**Fixed:** A stalled fal.ai request no longer hangs the method. Every request
now has a 60-second deadline that covers the response body, and a timeout raises
an error naming the HTTP method and URL.

**Fixed:** An empty 2xx response body (such as a 202 or 204) is handled
explicitly. Paginated list calls treat it as an empty page instead of failing
with a bare `SyntaxError`. Methods that must return data (get, create, update,
and unpaginated list) raise an error naming the HTTP method and path instead of
failing later with a `TypeError`. Delete and action methods still accept an
empty body. A malformed JSON body now raises an error that names the HTTP
method, path, and status code.

**Changed:** A `Retry-After` header on a 429 response is capped at 30 seconds
per retry, so a large value can no longer stall a call for minutes. Retry count
is unchanged.
