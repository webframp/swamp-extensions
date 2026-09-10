# Swamp Club Lab adapter

`@webframp/swamp-club` is deliberately narrow: it reads one Lab issue into versioned Swamp data and posts an already-approved acknowledgement ripple. It does not invoke or replace `@swamp/issue-lifecycle`.

```bash
swamp model create @webframp/swamp-club lab --global-arg host=swamp-club.com
swamp model method run lab get_lab_issue_context --input issueNumber=2068
```

The API key is a sensitive global argument and should be supplied from a Swamp vault. `post_ripple` accepts exact approved text and records the returned remote comment identifier.

```bash
swamp model method run lab post_ripple --input issueNumber=2068 --input body='Linked issue: https://github.com/webframp/swamp-extensions/issues/1' --input idempotencyKey=triage-example
```
