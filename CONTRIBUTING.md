# Contributing to swamp-extensions

Bug reports and feature requests are welcome. Pull requests are only rarely
accepted, and only from contributors I already trust — this isn't a
"PRs welcome" repo.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/webframp/swamp-extensions/issues).
Include the extension name (e.g. `@webframp/gitlab`), the method you ran, and
what you expected vs. what happened. Logs help; redact anything sensitive
(tokens, account IDs) first.

If your report includes a suggested fix or a code sample, that's genuinely
useful — I'll implement it myself (with attribution, if you'd like it) rather
than asking you to open a PR.

## Why pull requests are limited

AI agents make it cheap to generate plausible-looking code fast, which makes
an open "PRs welcome" policy a real supply-chain risk for a repo of
credential-touching infrastructure integrations — a subtly wrong permission
check, a prompt-injection payload smuggled through a code sample, or a quiet
dependency swap are all things I'd rather review from someone I already trust
than from an unknown contributor. This mirrors Swamp's own first-party stance
in [`swamp-club/swamp-extensions`](https://github.com/swamp-club/swamp-extensions/blob/main/CONTRIBUTING.md),
though it's an exception here rather than an absolute rule.

If you'd like to contribute code directly and haven't before, open an issue
first and say so. Trusted-contributor status is something that gets built up
over a few good issues or conversations, not granted by default from a first
PR. It is solely at my discression as the primary maintainer.

## For trusted contributors

Read `CLAUDE.md` (and/or `AGENTS.md`) first — it's the source of truth for this
repo's conventions. Follow swamp's own guidance for everything CLI- and
extension-development-related (the `swamp` and `swamp-getting-started`
skills, or `swamp help`) rather than improvising around it.

Branch from `main`, commit with [Conventional
Commits](https://www.conventionalcommits.org/), and open a PR. Tag
[@webframp](https://github.com/webframp) on it — only I can approve CI to run
on the PR and issue `/lgtm`, `/approve`, or `/shipit`, so a PR sitting
untagged just sits. Once CI and the adversarial review pass and I approve, it
squash-merges and auto-publishes to the [swamp.club registry](https://swamp.club).

## Licensing

Every extension in this repo carries its own `LICENSE.md`, independent of
Swamp's own AGPLv3 license — see Swamp's [Extension and Definition
Exception](https://github.com/swamp-club/swamp-extensions/blob/main/COPYING-EXCEPTION)
for why that's allowed. Most extensions here are Apache 2.0.

## Code of conduct

Be respectful, assume good faith, and keep discussion technical. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
