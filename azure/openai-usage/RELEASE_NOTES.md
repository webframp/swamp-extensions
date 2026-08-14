## 2026.08.14.1

**Fixed:** `listAiResources` ignored the ARM API's `nextLink` pagination
cursor, silently dropping resources past the first page. `GET
.../Microsoft.CognitiveServices/accounts` paginates at a small page size
(observed: 2 per page); a subscription with 10 OpenAI/AIServices accounts
was reporting only 1 in `scan_subscriptions` and `list_ai_resources` output.
Both methods now follow `nextLink` until exhausted.

## 2026.07.31.1

**Fixed:** README incorrectly stated authentication uses `az` CLI (`az login`).
The extension actually uses Azure AD client credentials flow requiring
`tenantId`, `clientId`, and `clientSecret` global arguments. README now documents
the correct auth mechanism, required role (Reader on subscriptions), and all
required global arguments.
