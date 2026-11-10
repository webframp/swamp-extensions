import { assertEquals } from "@std/assert";
import { determineVerdict, MIN_REVIEW_BYTES } from "./verdict.ts";

const BODY = "x".repeat(MIN_REVIEW_BYTES);

Deno.test("an explicit pass marker passes", () => {
  assertEquals(
    determineVerdict(`## Review\n\nNo findings.\n\nVERDICT: pass\n`).kind,
    "pass",
  );
});

Deno.test("an explicit fail marker fails", () => {
  assertEquals(determineVerdict(`${BODY}\nVERDICT: fail\n`).kind, "fail");
});

Deno.test("markdown emphasis around the marker is accepted", () => {
  assertEquals(determineVerdict(`${BODY}\n**VERDICT: pass**\n`).kind, "pass");
  assertEquals(determineVerdict(`${BODY}\n**VERDICT:** fail\n`).kind, "fail");
});

Deno.test("a stub body with no marker is missing, not a pass or a fail", () => {
  // The shape that blocked PR 413: a body that says nothing.
  const v = determineVerdict("ADVERSARIAL REVIEW FINDINGS - SEE BELOW");
  assertEquals(v, { kind: "missing", reason: "empty-output" });
});

Deno.test("a long review without the marker is missing for want of a marker", () => {
  assertEquals(
    determineVerdict(`${BODY} and plenty of prose but no verdict line`),
    { kind: "missing", reason: "no-marker" },
  );
});

Deno.test("empty output is missing", () => {
  assertEquals(determineVerdict(""), {
    kind: "missing",
    reason: "empty-output",
  });
});

Deno.test("a marker mid-sentence is not an answer", () => {
  assertEquals(
    determineVerdict(`${BODY} I will state VERDICT: pass once I have checked.`)
      .kind,
    "missing",
  );
});

Deno.test("a marker quoted inside a code block is not an answer", () => {
  const out = `${BODY}\n\n\`\`\`\nVERDICT: pass\n\`\`\`\n`;
  assertEquals(determineVerdict(out).kind, "missing");
});

Deno.test("provider errors win over a marker", () => {
  assertEquals(
    determineVerdict(`rate_limit_error: slow down\nVERDICT: pass\n`).kind,
    "provider-error",
  );
});

Deno.test("an error code quoted in code is not a provider error", () => {
  const out =
    `${BODY}\nThe client maps \`invalid_api_key\` to 401.\nVERDICT: pass\n`;
  assertEquals(determineVerdict(out).kind, "pass");
});

Deno.test("an error code quoted in a fenced block is not a provider error", () => {
  const out =
    `${BODY}\n\`\`\`ts\nthrow new Error("invalid_api_key");\n\`\`\`\nVERDICT: fail\n`;
  assertEquals(determineVerdict(out).kind, "fail");
});
