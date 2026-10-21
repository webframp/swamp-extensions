// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createReportTestContext } from "@swamp-club/swamp-testing";
import {
  lineDiff,
  report,
  sectionGroup,
  selfCheck,
  toFindings,
} from "./editorial_review.ts";

const REVIEW_TYPE = "@webframp/editorial-review";
const CLAUDE_TYPE = "@keeb/anthropic/claude";

const ORIGINAL = "There is a plan. There is a risk. There is a fix. It works.";

function request(overrides: Record<string, unknown> = {}) {
  const sentences = [
    { index: 0, text: "There is a plan.", words: 4, opener: "there" },
    { index: 1, text: "There is a risk.", words: 4, opener: "there" },
    { index: 2, text: "There is a fix.", words: 4, opener: "there" },
    { index: 3, text: "It works.", words: 2, opener: "it" },
  ];
  const doc = {
    source: "file",
    path: "docs/post.md",
    text: ORIGINAL,
    sha256: "a".repeat(64),
    bytes: ORIGINAL.length,
    wordCount: 14,
    sentenceCount: 4,
    codeBlockCount: 0,
    sentences,
  };
  return {
    pass: "review",
    contentKind: "blog post",
    draft: doc,
    original: doc,
    guide: {
      file: "guides/editorial-principles.md",
      sha256: "b".repeat(64),
      bytes: 1,
    },
    voice: null,
    systemPrompt: "s",
    reviewPrompt: "p",
    outputSchema: {},
    extensionVersion: "x",
    timestamp: "t",
    ...overrides,
  };
}

function result(structured: unknown, model = "claude-opus-5-5") {
  return {
    key: "review",
    batch: "editorial",
    ok: true,
    response: "{}",
    structured,
    model,
    costUsd: 0.1234,
    durationMs: 20400,
    timestamp: "t",
  };
}

const FIRST = result({
  findings: [
    {
      section: "2.7",
      sentence: "There is a plan.",
      problem: "Opens with There is.",
      suggestedFix: "We have a plan.",
    },
    {
      section: "3.8",
      sentence: "There is a risk. There is a fix.",
      problem: "Stacked declaratives.",
      suggestedFix: "",
    },
    {
      section: "voice:hedging",
      sentence: "It works.",
      problem: "Hedge | pipe.",
      suggestedFix: "It works.",
    },
  ],
  revisedDraft: "We have a plan, a risk and a fix. It works.",
  notes: "Openers repeat.",
});
const SECOND = result({
  findings: [],
  revisedDraft: "We have a plan, a risk and a fix. It works.",
});

function handle(name: string) {
  return {
    name,
    specName: "resource",
    kind: "resource" as const,
    dataId: `${name}-id`,
    version: 1,
    size: 1,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "infinite" as any,
      garbageCollection: 10 as any,
      streaming: false,
      tags: {},
      ownerDefinition: { ownerType: "workflow-step", ownerRef: "x" } as any,
    },
  };
}

function step(
  stepName: string,
  modelType: string,
  modelId: string,
  dataName: string,
  status = "succeeded",
) {
  return {
    jobName: stepName,
    stepName,
    taskType: "model_method",
    modelName: modelId,
    modelType,
    modelId,
    methodName: "m",
    status,
    dataHandles: [handle(dataName)],
    methodArgs: {},
    globalArgs: {},
  };
}

function artifact(
  modelType: string,
  modelId: string,
  name: string,
  body: unknown,
) {
  return {
    modelType,
    modelId,
    data: {
      name,
      kind: "resource" as const,
      dataId: `${name}-id`,
      version: 1,
      size: 1,
      contentType: "application/json",
    },
    content: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function run(opts: {
  request?: unknown;
  first?: unknown;
  second?: unknown;
  steps?: string[];
  inputs?: Record<string, unknown>;
}) {
  const names = opts.steps ?? ["prepare", "review", "recheck-review"];
  const stepDefs: Record<string, [string, string, string]> = {
    prepare: [REVIEW_TYPE, "review-id", "review-request"],
    review: [CLAUDE_TYPE, "claude-id", "cli-editorial-review"],
    "recheck-review": [CLAUDE_TYPE, "claude-id", "cli-editorial-recheck"],
  };
  const bodies: Record<string, unknown> = {
    prepare: "request" in opts ? opts.request : request(),
    review: "first" in opts ? opts.first : FIRST,
    "recheck-review": "second" in opts ? opts.second : SECOND,
  };
  const dataArtifacts = names
    .filter((n) => bodies[n] !== undefined)
    .map((n) =>
      artifact(stepDefs[n][0], stepDefs[n][1], stepDefs[n][2], bodies[n])
    );
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "@webframp/editorial-review",
    inputs: opts.inputs ?? {},
    stepExecutions: names.map((n) => step(n, ...stepDefs[n])),
    dataArtifacts,
  } as any);
  return report.execute(context as any);
}

// --- pure helpers ------------------------------------------------------------

Deno.test("sectionGroup maps guide numbers and voice entries", () => {
  assertEquals(sectionGroup("1.3"), "1. Correctness (Dreyer)");
  assertEquals(sectionGroup("2.7"), "2. The sentence (Klinkenborg)");
  assertEquals(sectionGroup(" 3.10 "), "3. Anti-patterns");
  assertEquals(sectionGroup("4"), "4. House style");
  assertEquals(sectionGroup("voice:kill-list"), "House voice");
  assertEquals(sectionGroup("12"), "Other");
  assertEquals(sectionGroup(""), "Other");
});

Deno.test("toFindings drops malformed entries and fills defaults", () => {
  assertEquals(toFindings("nope"), []);
  assertEquals(
    toFindings([null, 3, {}, { sentence: "S." }]),
    [{ section: "?", sentence: "S.", problem: "", suggestedFix: "" }],
  );
});

Deno.test("selfCheck counts openers and flags repeats", () => {
  const sc = selfCheck(request().original.sentences)!;
  assertEquals(sc.minWords, 2);
  assertEquals(sc.maxWords, 4);
  assertEquals(sc.meanWords, 3.5);
  assertEquals(sc.openers[0], { opener: "there", count: 3 });
  assertEquals(sc.repeatedOpeners, ["there"]);
  assertEquals(sc.flaggedOpeners.map((o) => o.opener), ["there", "it"]);
  assertEquals(selfCheck([]), null);
});

Deno.test("lineDiff marks removed and added lines", () => {
  assertEquals(lineDiff("a\nb\nc", "a\nB\nc"), [" a", "-b", "+B", " c"]);
  assertEquals(lineDiff("", ""), [" "]);
});

// --- report ------------------------------------------------------------------

Deno.test("report renders both passes, grouped findings and the final draft", async () => {
  const { markdown, json } = await run({});
  const r = json as any;
  assertEquals(r.status, "complete");
  assertEquals(r.degraded, false);
  assertEquals(r.passes.length, 2);
  assertEquals(r.passes[0].bySection, {
    "2. The sentence (Klinkenborg)": 1,
    "3. Anti-patterns": 1,
    "House voice": 1,
  });
  assertEquals(r.finalDraft, "We have a plan, a risk and a fix. It works.");
  assertEquals(r.economy, {
    originalWords: 14,
    finalWords: 11,
    deltaWords: -3,
    grew: false,
  });
  assertStringIncludes(markdown, "## First pass: 3 findings");
  assertStringIncludes(markdown, "### 3. Anti-patterns (1)");
  assertStringIncludes(markdown, "*(delete)*");
  assertStringIncludes(markdown, "Hedge \\| pipe.");
  assertStringIncludes(markdown, "## Second pass: 0 findings");
  assertStringIncludes(markdown, "No violations remain");
  assertStringIncludes(markdown, 'Repeated openers: "there"');
  assertStringIncludes(markdown, "`docs/post.md` (blog post)");
  assert(!markdown.includes("Warning:"));
});

Deno.test("report warns when the revision grew", async () => {
  const longer = result({
    findings: [],
    revisedDraft: `${ORIGINAL} And more words here.`,
  });
  const { markdown, json } = await run({
    first: longer,
    steps: ["prepare", "review"],
    inputs: { recheck: false },
  });
  assertEquals((json as any).economy.grew, true);
  assertEquals((json as any).status, "complete");
  assertStringIncludes(markdown, "**Warning:** the revision is longer");
});

Deno.test("report uses the first revision when recheck was turned off", async () => {
  for (const recheck of [false, "false"]) {
    const { json } = await run({
      steps: ["prepare", "review"],
      inputs: { recheck },
    });
    const r = json as any;
    assertEquals(r.degraded, false);
    assertEquals(r.passes.length, 1);
  }
});

Deno.test("report degrades to partial when the expected recheck is missing", async () => {
  const { json } = await run({ steps: ["prepare", "review"] });
  const r = json as any;
  assertEquals(r.status, "partial");
  assertEquals(r.finalDraft, "We have a plan, a risk and a fix. It works.");
  assertStringIncludes(r.notes[0], "second-pass step is absent");
});

Deno.test("report degrades when the second pass has no structured answer", async () => {
  const { json } = await run({ second: { response: "x", model: "m" } });
  const r = json as any;
  assertEquals(r.status, "partial");
  assertEquals(r.passes.length, 1);
});

Deno.test("report degrades without a prepare step or request data", async () => {
  for (const opts of [{ steps: ["review"] }, { request: undefined }]) {
    const { markdown, json } = await run(opts);
    const r = json as any;
    assertEquals(r.status, "degraded");
    assertEquals(r.degraded, true);
    assertStringIncludes(markdown, "**Degraded:**");
  }
});

Deno.test("report degrades when the first pass is missing or unstructured", async () => {
  for (
    const opts of [{ steps: ["prepare"] }, {
      first: { response: "plain text" },
    }]
  ) {
    const { json } = await run(opts);
    const r = json as any;
    assertEquals(r.status, "degraded");
    assert(r.draft !== null, "draft summary still reported");
    assert(r.selfCheck !== null, "self-check still reported");
  }
});

Deno.test("report surfaces a failed claude call", async () => {
  const failed = {
    ...result(undefined),
    ok: false,
    error: "claude exited 1: rate limited",
  };
  const { json } = await run({ first: failed });
  const r = json as any;
  assertEquals(r.status, "degraded");
  assertStringIncludes(r.notes[0], "claude exited 1: rate limited");

  const { json: j2 } = await run({ second: { ...failed } });
  assertEquals((j2 as any).status, "partial");
  assertStringIncludes(
    (j2 as any).notes[0],
    "Second pass: the claude call failed",
  );
});

Deno.test("report shows serving model, duration and cost", async () => {
  const { markdown, json } = await run({});
  assertEquals((json as any).passes[0].costUsd, 0.1234);
  assertStringIncludes(
    markdown,
    "Served by `claude-opus-5-5` in 20s for $0.1234.",
  );
});

Deno.test("report ignores a failed review step", async () => {
  const { json } = await run({ steps: ["prepare"] });
  assertStringIncludes((json as any).notes[0], "first-pass review step");
});

Deno.test("report fences a draft that contains backtick fences", async () => {
  const draft = "Text.\n\n```\ncode\n```\n";
  const { markdown } = await run({
    first: result({ findings: [], revisedDraft: draft }),
    steps: ["prepare", "review"],
    inputs: { recheck: false },
  });
  assertStringIncludes(markdown, "````markdown\nText.");
});

// --- adversarial-review regressions ------------------------------------------

Deno.test("report degrades on a malformed answer instead of reporting success", async () => {
  for (
    const structured of [
      { revisedDraft: "" },
      { findings: [], revisedDraft: "" },
      { findings: "none", revisedDraft: "Text." },
    ]
  ) {
    const { json } = await run({
      first: result(structured),
      steps: ["prepare", "review"],
      inputs: { recheck: false },
    });
    const r = json as any;
    assertEquals(r.status, "degraded");
    assertEquals(r.finalDraft, null);
  }
});

Deno.test("report escapes backslashes and pipes in table cells", async () => {
  const { markdown } = await run({
    first: result({
      findings: [{
        section: "1.3",
        sentence: "a \\| b",
        problem: "p",
        suggestedFix: "",
      }],
      revisedDraft: "x",
    }),
    steps: ["prepare", "review"],
    inputs: { recheck: false },
  });
  assertStringIncludes(markdown, "| a \\\\\\| b |");
});

Deno.test("report keeps model notes and errors on one line", async () => {
  const { markdown } = await run({
    first: result({
      findings: [],
      revisedDraft: "x",
      notes: "line1\n# Injected",
    }),
    steps: ["prepare", "review"],
    inputs: { recheck: false },
  });
  assertStringIncludes(markdown, "**Notes:** line1 # Injected");
  assert(!markdown.includes("\n# Injected"));

  const failed = { ...result(undefined), ok: false, error: "boom\n# Heading" };
  const { markdown: m2 } = await run({ first: failed });
  assertStringIncludes(
    m2,
    "> - First pass: the claude call failed: boom # Heading.",
  );
});

Deno.test("report survives a draft with very many backtick runs", async () => {
  const big = "` x\n".repeat(160_000);
  const { markdown, json } = await run({
    request: request({
      original: { ...request().original, text: big },
    }),
    first: result({ findings: [], revisedDraft: `${big}tail` }),
    steps: ["prepare", "review"],
    inputs: { recheck: false },
  });
  assertEquals((json as any).status, "complete");
  assertStringIncludes(
    markdown,
    "The draft is too large to diff line by line.",
  );
  assertStringIncludes(markdown, "## Revised draft");
});
