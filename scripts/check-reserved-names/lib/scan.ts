/**
 * Detects data names that swamp reserves for internal use.
 *
 * swamp rejects these names when a method writes them:
 *
 *   Error: Data name 'latest' is reserved for internal use in model '...'.
 *
 * The extension test context (`createModelTestContext`) accepts any name, so
 * `deno task test` and `swamp extension quality` both pass. Only a live swamp
 * run fails. This scan closes that gap statically.
 *
 * Limits: it matches quoted literals inside the data-name argument of
 * `writeResource`/`writeFile`/`readResource`/`readFile`. A name held in a
 * variable (`const n = "latest"`) or built by concatenation is not detected;
 * generators under `scripts/` get a stricter any-quoted-literal check.
 *
 * @module
 */

/** Data names swamp reserves. Add new reserved words here and nowhere else. */
export const RESERVED_DATA_NAMES: readonly string[] = ["latest"];

export interface Finding {
  file: string;
  line: number;
  reason: string;
  text: string;
}

const QUOTE = "([\"'`])";

function reservedAlternation(): string {
  return RESERVED_DATA_NAMES.map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  )
    .join("|");
}

/**
 * `writeResource(<spec>, ..."<reserved>"...` — the data name is the second
 * argument, so a quoted reserved literal anywhere in that argument (plain,
 * ternary branch, `??` fallback) is reported. Case-insensitive.
 */
function writeCall(): RegExp {
  return new RegExp(
    `\\b(writeResource|writeFile)\\(\\s*(?:"[^"]*"|'[^']*'|\`[^\`]*\`|[\\w.$]+)\\s*,\\s*[^,()]*?${QUOTE}(${reservedAlternation()})\\2`,
    "gi",
  );
}

/** `readResource(..."<reserved>"...)` — the data name is the first argument. */
function readCall(): RegExp {
  return new RegExp(
    `\\b(readResource|readFile)\\(\\s*[^,()]*?${QUOTE}(${reservedAlternation()})\\2`,
    "gi",
  );
}

/** A reserved name as a quoted literal, e.g. a codegen instance constant. */
function anyLiteral(): RegExp {
  return new RegExp(`${QUOTE}(${reservedAlternation()})\\1`);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Scan one source file.
 *
 * Call sites are checked everywhere, including multi-line calls and the
 * `writeResource(...)` text a code generator emits. Inside `scripts/`, any
 * quoted reserved literal on a non-comment line is also reported, because
 * generators build instance names from constants and templates.
 */
export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const lines = source.split("\n");
  for (const re of [writeCall(), readCall()]) {
    for (const m of source.matchAll(re)) {
      const line = lineOf(source, m.index ?? 0);
      findings.push({
        file,
        line,
        reason: `reserved data name '${m[3]}' passed to ${m[1]}`,
        text: lines[line - 1].trim(),
      });
    }
  }
  if (file.startsWith("scripts/")) {
    const literal = anyLiteral();
    lines.forEach((text, i) => {
      if (isComment(text) || !literal.test(text)) return;
      if (findings.some((f) => f.line === i + 1)) return;
      findings.push({
        file,
        line: i + 1,
        reason: "reserved data name used as a literal in a code generator",
        text: text.trim(),
      });
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}
