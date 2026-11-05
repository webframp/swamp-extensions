---
inclusion: always
---
# Work Discipline: Understand First, Don't Thrash

These rules are binding, not advisory. They exist because an earlier session
wasted 20+ minutes looping through incremental fixes without explaining why,
making wrong first attempts that forced rework, and going silent during long
operations. Never repeat that.

## State the "why" before you act

Before any multi-step change, write one or two plain sentences: what you are
about to do and why, tied to the actual request. No work begins until that is
stated. The user must never have to ask "what are you doing?"

- Before editing, say what you will change and the expected result.
- Before a long command (regeneration, full test suite, spec fetch), say what it
  does and that it will take time.
- When a step finishes, say what it produced in one line before the next step.

## Understand the root cause before fixing — once

When something is broken, diagnose it fully before writing a fix. Read the
relevant code and confirm the mechanism. State the root cause in one sentence,
then fix it once, correctly.

- Do NOT make a guess-fix, run, see it fail, tweak, run again. That is thrash.
- If a fix is wrong, STOP. Do not patch the patch. Re-read, find the real cause,
  and explain what you got wrong before trying again.
- If two attempts at an approach fail, stop and change approach — or ask. Never
  a third variation of the same guess.

## One correct pass beats many partial passes

A single fix applied with full understanding is faster and cleaner than a
sequence of corrections. When the same defect spans several places (e.g. the
same bug in multiple codegen generators), understand it once, write the fix
once, then apply it everywhere in parallel — do not serially discover it N
times.

- Fix the generator/root, not each generated artifact by hand.
- When work is independent and repeated across targets, run it concurrently
  (parallel subagents with a shared, written spec and common lessons), not one
  target after another.

## Don't go dark on long work

During any operation that runs more than a minute (regeneration over hundreds of
methods, repo-wide test runs, large sweeps), surface progress. The user should
see what is happening without having to wait and wonder. Prefer a short status
line per phase over a long silence followed by a wall of output.

## Scope discipline — do what was asked, flag the rest

Solve the stated problem. When you discover an adjacent or pre-existing issue,
name it explicitly and ask before expanding scope. Do not silently balloon a
one-line review finding into a multi-generator rewrite without saying so and
getting agreement. Leftover issues get named as follow-ups, not chased in the
same breath.

## Codegen-specific: regenerate once, deliberately

Swamp extension generators here version on a content hash that includes the
(non-shipped) test file, so repeated regenerations re-bump versions and create
visible churn. Therefore:

1. Finalize ALL generator edits first.
2. Reset the affected extensions to the committed baseline
   (`git checkout HEAD -- <dir>/`).
3. Regenerate EXACTLY ONCE.
4. Revert any extension whose shipped model is byte-identical (only version +
   upgrades changed, test differs) — that is a test-only change and must not
   bump.
5. Hand-write `RELEASE_NOTES.md` (generators overwrite it with a placeholder and
   truncate history).

Never regenerate repeatedly to "see what changes." Decide, then run once.
