## 2026.08.21.1

**Changed:** Added `.describe()` and `.min(1)` to the `zone_id`, `job_id`,
and `dataset_id` identifier arguments used across most methods, and added a
`.describe()` to the `destination_conf` argument. No behavioral changes.

## 2026.07.27.1

**Fixed:** Regenerated from `scripts/cloudflare-codegen` after two generator
bugs were repaired (webframp/swamp-extensions#284).

1. **Methods referencing an undeclared path parameter did not compile.** The
   generator derived a method's arguments schema and execute signature from the
   OpenAPI `parameters` list, but built the request URL from the path template.
   Where the Cloudflare spec omits a declaration for a `{placeholder}` — which
   it does in several places — the result was a method with
   `arguments:
   z.object({})` and an unused `_args` parameter whose body still
   interpolated `args.<name>`. Those methods failed type checking and were
   uncallable even if they had compiled, because the argument was never
   declared. Path-template placeholders are now unioned into the declared
   parameters, so the schema, the signature, and the body agree.

2. **Generated tests could request a URL the mock server did not serve.** Test
   arguments merged the request-body fixture over the path-parameter values, so
   a body property sharing a name with a path parameter (commonly `id`)
   substituted its own example value into the URL. The request then missed the
   mock and failed with `Cloudflare API error: Not found`. Path parameters now
   take precedence, matching what the generated model already does by excluding
   path-parameter names from the request body.

**Upgrade note:** No API surface change and no method was added or removed. If
this extension type-checked and tested cleanly before, its behavior is unchanged
and only the version moved. Extensions that previously failed `deno check` or
`deno task test` now pass.
