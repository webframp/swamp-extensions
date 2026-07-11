# Security Policy

## Reporting a vulnerability

If you find a security issue in one of these extensions — credential
handling, injection via unsanitized input, an overly broad permission
request, or anything that could leak a secret or let an extension act
outside its declared scope — please report it privately rather than opening
a public issue.

Use [GitHub's private vulnerability
reporting](https://github.com/webframp/swamp-extensions/security/advisories/new)
for this repo. Include:

- The extension name and version (from `manifest.yaml`)
- The method or code path involved
- Steps to reproduce, or a proof of concept

## What to expect

This is a solo-maintained, best-effort project — there's no SLA. Reports get
acknowledged as soon as possible, with a fix (version bump plus a
`RELEASE_NOTES.md` entry) targeted before any public disclosure. If you don't
hear back within a couple of weeks, a follow-up nudge is fine.

## Scope

This covers the extension code in this repository. It does not cover:

- Swamp itself — report to [Swamp Club](https://github.com/swamp-club/swamp)
- The third-party services extensions integrate with (AWS, GitLab,
  Cloudflare, etc.)
- Issues that require you to already control the swamp repo's vault or config
