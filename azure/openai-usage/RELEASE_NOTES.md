## 2026.07.31.1

**Fixed:** README incorrectly stated authentication uses `az` CLI (`az login`).
The extension actually uses Azure AD client credentials flow requiring
`tenantId`, `clientId`, and `clientSecret` global arguments. README now documents
the correct auth mechanism, required role (Reader on subscriptions), and all
required global arguments.
