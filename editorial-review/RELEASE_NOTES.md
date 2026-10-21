# Release Notes — @webframp/editorial-review

## 2026.10.21.1

Initial release.

### Added

- **Model `@webframp/editorial-review`.** `prepare` resolves a draft from a repo
  path or inline text, hashes it, splits its prose into sentences and writes a
  review request. The request embeds the bundled principles and, when
  `voiceModel` is set, a `@dougschaefer/writing-voice` profile. `recheck` builds
  the second-pass request from the first pass's revised draft. Draft paths must
  resolve inside the repository; symlinks are resolved before the check.
- **Workflow `@webframp/editorial-review`.** prepare, a first Claude pass, and
  an optional second pass (`recheck`, default on), each pass through
  `@keeb/anthropic/claude` `cli_generate_many` with a JSON schema and followed
  by an assert on the answer's shape. The model (`claude-opus-5-5` by default),
  effort, timeout and instance name are inputs.
- **Workflow-scope report `@webframp/editorial-review`.** Findings grouped by
  guide section, the sentence-shape self-check, before and after word counts
  with a warning when the revision grew, a line diff and the final draft.
- **Bundled principles** in `guides/editorial-principles.md`. The request
  records their sha256, so each review is tied to the guide version it used.
