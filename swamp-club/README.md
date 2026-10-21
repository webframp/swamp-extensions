# Swamp Club Lab adapter

`@webframp/swamp-club` is deliberately narrow: it reads one Lab issue into
versioned Swamp data and posts an already-approved acknowledgement ripple. It
does not invoke or replace `@swamp/issue-lifecycle`.

Store the Swamp Club API key in a swamp vault and reference it with a
`vault.get` expression; never pass the literal value. Any vault type works —
`local_encryption`, or an extension such as `@webframp/pass`,
`@webframp/gopass`, `@webframp/hashicorp-vault` or `@webframp/macos-keychain`.

```bash
swamp vault create local_encryption swamp-club   # once, if you have no vault yet
swamp vault put swamp-club API_KEY               # prompts; the value never touches shell history
swamp model create @webframp/swamp-club lab \
  --global-arg host=swamp-club.com \
  --global-arg 'apiKey=${{ vault.get("swamp-club", "API_KEY") }}'
swamp model method run lab get_lab_issue_context --input issueNumber=2068
```

`post_ripple` accepts exact approved text and records the returned remote
comment identifier.

```bash
swamp model method run lab post_ripple --input issueNumber=2068 --input body='Linked issue: https://github.com/webframp/swamp-extensions/issues/1' --input idempotencyKey=triage-example
```
