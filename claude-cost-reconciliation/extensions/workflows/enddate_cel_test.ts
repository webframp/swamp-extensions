/**
 * Executed regression for the workflow's `endDate` / `start` CEL derivation.
 *
 * The reconciliation workflow derives the exclusive end of the billing window
 * from the `month` input entirely in CEL (no model-side date helper). The
 * December year-rollover and single-digit zero-padding are the fragile cases,
 * so this test extracts the exact CEL expression from the shipped workflow YAML
 * (reading it from the file so the test and the shipped expression cannot
 * drift) and evaluates it with the same `cel-js` the swamp engine uses.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:@marcbachmann/cel-js@7.6.1";

const WORKFLOW = new URL(
  "./claude-cost-reconciliation.yaml",
  import.meta.url,
);

/** Pull the inner CEL text out of a `key: '${{ <expr> }}'` YAML line. */
function extractExpr(yaml: string, key: string): string {
  const line = yaml
    .split("\n")
    .find((l) => l.trimStart().startsWith(`${key}:`));
  if (!line) throw new Error(`no "${key}:" line in workflow yaml`);
  const match = line.match(/\$\{\{\s*([\s\S]*?)\s*\}\}/);
  if (!match) throw new Error(`no \${{ }} expression on the "${key}:" line`);
  return match[1];
}

function evalCel(expr: string, month: string): unknown {
  // deno-lint-ignore no-explicit-any
  const program = parse(expr) as any;
  const fn = typeof program === "function"
    ? program
    : (ctx: unknown) => program.eval(ctx);
  return fn({ inputs: { month } });
}

Deno.test("workflow endDate CEL: window boundaries incl Dec rollover + zero-pad", async () => {
  const yaml = await Deno.readTextFile(WORKFLOW);
  // Both steps embed the same start/end expressions; the first `start:` and
  // `end:` lines (the aws_cost step) are representative.
  const startExpr = extractExpr(yaml, "start");
  const endExpr = extractExpr(yaml, "end");

  const cases: Array<[string, string, string]> = [
    ["2026-01", "2026-01-01", "2026-02-01"],
    ["2026-02", "2026-02-01", "2026-03-01"], // single-digit zero-pad
    ["2026-09", "2026-09-01", "2026-10-01"], // mid-year month
    ["2026-11", "2026-11-01", "2026-12-01"],
    ["2026-12", "2026-12-01", "2027-01-01"], // December year rollover
  ];

  for (const [month, wantStart, wantEnd] of cases) {
    assertEquals(evalCel(startExpr, month), wantStart, `start for ${month}`);
    assertEquals(evalCel(endExpr, month), wantEnd, `end for ${month}`);
  }
});

Deno.test("workflow startDate/endDate CEL match the aws start/end", async () => {
  const yaml = await Deno.readTextFile(WORKFLOW);
  // The Anthropic step uses startDate/endDate; they must derive the identical
  // window as the AWS step's start/end (the report's window-agreement gate
  // depends on this).
  const startDate = extractExpr(yaml, "startDate");
  const endDate = extractExpr(yaml, "endDate");
  for (const month of ["2026-02", "2026-12"]) {
    assertEquals(
      evalCel(startDate, month),
      evalCel(extractExpr(yaml, "start"), month),
    );
    assertEquals(
      evalCel(endDate, month),
      evalCel(extractExpr(yaml, "end"), month),
    );
  }
});
