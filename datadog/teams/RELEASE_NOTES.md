## 2026.10.07.1

**Added:** Team notification rules accept a `servicenow` notification target
(with `templates`) on `create_team_notification_rule` and
`update_team_notification_rule`, and the stored rule schema includes it. Email
notification settings gain an optional `recipient_email` field.

**Fixed:** The shared API helper no longer throws on a successful response with
an empty body (such as 202 Accepted); it returns an empty result. Paginated list
requests tolerate an empty page body the same way. A body that is not valid JSON
now fails with an error naming the HTTP method, path, and status, with a snippet
of the body.

**Upgrade note:** Additive changes only; existing stored resources remain valid
and no migration is needed.
