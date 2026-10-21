/**
 * Report: @webframp/editorial-review (workflow scope).
 *
 * Joins the editorial-review workflow's data: the prepared request (draft,
 * principle and voice hashes, sentence stats), the first-pass Claude result,
 * and the optional second pass. Renders the findings grouped by guide
 * section, the sentence-shape self-check (guide 2.3) over the original
 * draft, an economy check that flags a revision longer than the original, a
 * line diff, and the final draft.
 *
 * The report degrades, never throws: a missing step, absent data or a parse
 * failure still yields `{ markdown, json }`, with `degraded: true` and a note
 * saying what was missing.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

import { type DataRepository, readJson } from "./_lib/read.ts";

const REVIEW_TYPE = "@webframp/editorial-review";
const CLAUDE_TYPE = "@keeb/anthropic/claude";
/** cli_generate_many stores each answer as cli-<batch>-<key>. */
const REVIEW_RESULT = "cli-editorial-review";
const RECHECK_RESULT = "cli-editorial-recheck";

/** Openers that guide 2.7 asks the writer to question. */
const FLAGGED_OPENERS = new Set([
  "there",
  "it",
  "when",
  "while",
  "since",
  "because",
  "however",
  "moreover",
  "indeed",
  "thus",
  "therefore",
]);

const DIFF_OMITTED = "The draft is too large to diff line by line.";

/** Line-diff budget: skip the diff when lines(original) x lines(final) exceeds it. */
const DIFF_CELL_LIMIT = 4_000_000;

interface DataHandle {
  name: string;
  specName?: string;
  version?: number;
}

interface StepExecution {
  jobName?: string;
  stepName?: string;
  modelName?: string;
  modelType: string;
  modelId: string;
  methodName?: string;
  status?: string;
  dataHandles?: DataHandle[];
}

interface WorkflowReportContext {
  workflowName?: string;
  workflowStatus?: string;
  inputs?: Record<string, unknown>;
  stepExecutions?: StepExecution[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

/** One editorial finding, normalised from the model's structured output. */
export interface Finding {
  section: string;
  sentence: string;
  problem: string;
  suggestedFix: string;
}

interface PassResult {
  pass: "review" | "recheck";
  servedBy: string | null;
  costUsd: number | null;
  durationMs: number | null;
  findings: Finding[];
  bySection: Record<string, number>;
  revisedDraft: string;
  notes: string;
}

interface Sentence {
  text: string;
  words: number;
  opener: string;
}

/** The JSON contract. */
export interface EditorialReport {
  status: "complete" | "partial" | "degraded";
  contentKind: string | null;
  draft: {
    source: string;
    path: string;
    sha256: string;
    wordCount: number;
    sentenceCount: number;
    codeBlockCount: number;
  } | null;
  guide: { file: string; sha256: string } | null;
  voice: {
    model: string;
    hasProfile: boolean;
    antiPatternCount: number;
    killListCount: number;
  } | null;
  passes: PassResult[];
  selfCheck: {
    sentenceLengths: number[];
    minWords: number;
    maxWords: number;
    meanWords: number;
    openers: { opener: string; count: number }[];
    repeatedOpeners: string[];
    flaggedOpeners: { opener: string; count: number }[];
  } | null;
  economy: {
    originalWords: number;
    finalWords: number;
    deltaWords: number;
    grew: boolean;
  } | null;
  diff: string[] | null;
  finalDraft: string | null;
  notes: string[];
  degraded: boolean;
  generatedAt: string;
}

// =============================================================================
// Helpers
// =============================================================================

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

/** Same word rule as the model: tokens containing a letter or digit. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Group a guide section number into the guide's parts. */
export function sectionGroup(section: string): string {
  const s = section.trim().toLowerCase();
  if (s.startsWith("voice")) return "House voice";
  if (/^1(\.|$)/.test(s)) return "1. Correctness (Dreyer)";
  if (/^2(\.|$)/.test(s)) return "2. The sentence (Klinkenborg)";
  if (/^3(\.|$)/.test(s)) return "3. Anti-patterns";
  if (/^4(\.|$)/.test(s)) return "4. House style";
  return "Other";
}

const GROUP_ORDER = [
  "1. Correctness (Dreyer)",
  "2. The sentence (Klinkenborg)",
  "3. Anti-patterns",
  "4. House style",
  "House voice",
  "Other",
];

/** Normalise the model's findings; drop entries without a sentence or problem. */
export function toFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(obj)
    .filter((f): f is Record<string, unknown> =>
      f !== null && (str(f.sentence) !== "" || str(f.problem) !== "")
    )
    .map((f) => ({
      section: str(f.section).trim() || "?",
      sentence: str(f.sentence),
      problem: str(f.problem),
      suggestedFix: str(f.suggestedFix),
    }));
}

function countBySection(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    const g = sectionGroup(f.section);
    out[g] = (out[g] ?? 0) + 1;
  }
  return out;
}

/** The sentence-shape self-check (guide 2.3) over the request's sentences. */
export function selfCheck(sentences: Sentence[]): EditorialReport["selfCheck"] {
  if (sentences.length === 0) return null;
  const lengths = sentences.map((s) => s.words);
  const counts = new Map<string, number>();
  for (const s of sentences) {
    if (!s.opener) continue;
    counts.set(s.opener, (counts.get(s.opener) ?? 0) + 1);
  }
  const openers = [...counts.entries()]
    .map(([opener, count]) => ({ opener, count }))
    .sort((a, b) => b.count - a.count || a.opener.localeCompare(b.opener));
  // An opener is "repeated" when it starts at least three sentences and at
  // least a fifth of them; "the" and "a" in a long piece are not a pattern.
  const repeatedOpeners = openers
    .filter((o) => o.count >= 3 && o.count / sentences.length >= 0.2)
    .map((o) => o.opener);
  return {
    sentenceLengths: lengths,
    minWords: Math.min(...lengths),
    maxWords: Math.max(...lengths),
    meanWords: Math.round(
      (lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10,
    ) / 10,
    openers,
    repeatedOpeners,
    flaggedOpeners: openers.filter((o) => FLAGGED_OPENERS.has(o.opener)),
  };
}

/**
 * Line diff of two texts as unified-style lines (" ", "-", "+" prefixes), via
 * LCS. Returns null when the texts are too large to diff within the budget.
 */
export function lineDiff(a: string, b: string): string[] | null {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length * y.length > DIFF_CELL_LIMIT) return null;
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(` ${x[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${x[i++]}`);
    } else {
      out.push(`+${y[j++]}`);
    }
  }
  while (i < n) out.push(`-${x[i++]}`);
  while (j < m) out.push(`+${y[j++]}`);
  return out;
}

/** Escape a value for a markdown table cell. */
function cell(text: string): string {
  return oneLine(text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")) || "—";
}

/** Collapse a model- or error-supplied string to one line, so it adds no markdown blocks. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fence(text: string): string {
  // A loop, not Math.max(...runs): a large draft has more backtick runs than
  // the engine allows as call arguments.
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return "`".repeat(longest + 1);
}

function findStep(
  steps: StepExecution[],
  stepName: string,
  modelType: string,
): StepExecution | undefined {
  return steps.find((s) =>
    s.stepName === stepName && s.modelType === modelType &&
    s.status === "succeeded"
  );
}

function handleFor(
  step: StepExecution,
  dataName: string,
): DataHandle | undefined {
  return (step.dataHandles ?? []).find((h) => h?.name === dataName);
}

async function readStep(
  repo: DataRepository,
  step: StepExecution,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  const h = handleFor(step, dataName);
  if (!h) return null;
  const r = await readJson(
    repo,
    step.modelType,
    step.modelId,
    h.name,
    h.version,
  );
  return r.data;
}

/**
 * Turn a `cli_generate_many` cliResult into a pass, or say why it can't be
 * one. A failed call is stored with `ok: false` and an `error`, not thrown.
 */
function toPass(
  pass: PassResult["pass"],
  result: Record<string, unknown>,
): PassResult | string {
  if (result.ok === false) {
    return `the claude call failed: ${str(result.error) || "no error given"}`;
  }
  const structured = obj(result.structured);
  if (!structured) return "the answer has no structured output";
  if (!Array.isArray(structured.findings)) {
    return "the answer has no findings list";
  }
  if (str(structured.revisedDraft) === "") {
    return "the answer has an empty revisedDraft";
  }
  const findings = toFindings(structured.findings);
  return {
    pass,
    servedBy: str(result.model) || null,
    costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
    durationMs: typeof result.durationMs === "number"
      ? result.durationMs
      : null,
    findings,
    bySection: countBySection(findings),
    revisedDraft: str(structured.revisedDraft),
    notes: str(structured.notes),
  };
}

// =============================================================================
// Rendering
// =============================================================================

function renderFindings(p: PassResult): string[] {
  const title = p.pass === "review" ? "First pass" : "Second pass";
  const lines = [
    `## ${title}: ${p.findings.length} finding${
      p.findings.length === 1 ? "" : "s"
    }`,
    "",
  ];
  const served = [
    p.servedBy ? `Served by \`${p.servedBy}\`` : "",
    p.durationMs !== null ? `in ${Math.round(p.durationMs / 1000)}s` : "",
    p.costUsd !== null ? `for $${p.costUsd.toFixed(4)}` : "",
  ].filter(Boolean).join(" ");
  if (served) lines.push(`${served}.`, "");
  if (p.findings.length === 0) {
    lines.push(
      p.pass === "review"
        ? "No violations found."
        : "No violations remain after the first revision.",
      "",
    );
  }
  for (const group of GROUP_ORDER) {
    const rows = p.findings.filter((f) => sectionGroup(f.section) === group);
    if (rows.length === 0) continue;
    lines.push(
      `### ${group} (${rows.length})`,
      "",
      "| § | Sentence | Problem | Suggested fix |",
      "| --- | --- | --- | --- |",
      ...rows.map((f) =>
        `| ${cell(f.section)} | ${cell(f.sentence)} | ${cell(f.problem)} | ${
          f.suggestedFix ? cell(f.suggestedFix) : "*(delete)*"
        } |`
      ),
      "",
    );
  }
  if (p.notes) lines.push(`**Notes:** ${oneLine(p.notes)}`, "");
  return lines;
}

/** Render the report markdown from the JSON contract. */
export function renderMarkdown(r: EditorialReport): string {
  const lines: string[] = ["# Editorial review", ""];

  if (r.degraded) {
    lines.push(
      "> **Degraded:** the report could not read everything the workflow produced.",
      ...r.notes.map((n) => `> - ${oneLine(n)}`),
      "",
    );
  }

  if (r.draft) {
    const src = r.draft.source === "file"
      ? `\`${r.draft.path}\``
      : "inline text";
    lines.push(
      `- **Draft:** ${src}${
        r.contentKind ? ` (${r.contentKind})` : ""
      }, ${r.draft.wordCount} words, ${r.draft.sentenceCount} sentences, sha256 \`${
        r.draft.sha256.slice(0, 12)
      }\``,
    );
  }
  if (r.guide) {
    lines.push(
      `- **Principles:** \`${r.guide.file}\`, sha256 \`${
        r.guide.sha256.slice(0, 12)
      }\``,
    );
  }
  lines.push(
    r.voice
      ? `- **House voice:** \`${r.voice.model}\`, ${r.voice.antiPatternCount} anti-patterns, ${r.voice.killListCount} kill-list entries${
        r.voice.hasProfile ? "" : " (no voice-profile record)"
      }`
      : "- **House voice:** none",
    "",
  );

  for (const p of r.passes) lines.push(...renderFindings(p));

  if (r.economy) {
    lines.push("## Economy", "");
    lines.push(
      `${r.economy.originalWords} words before, ${r.economy.finalWords} after, counting the full text (${
        r.economy.deltaWords > 0 ? "+" : ""
      }${r.economy.deltaWords}).`,
      "",
    );
    if (r.economy.grew) {
      lines.push(
        "> **Warning:** the revision is longer than the original. Economy comes first; check that each added word carries meaning.",
        "",
      );
    }
  }

  if (r.selfCheck) {
    const sc = r.selfCheck;
    lines.push(
      "## Sentence shape (2.3 self-check, original draft)",
      "",
      `Lengths range from ${sc.minWords} to ${sc.maxWords} words (mean ${sc.meanWords}).`,
      "",
      `Lengths in order: ${sc.sentenceLengths.join(", ")}`,
      "",
      "| Opener | Sentences |",
      "| --- | --- |",
      ...sc.openers.slice(0, 10).map((o) =>
        `| ${cell(o.opener)}${
          FLAGGED_OPENERS.has(o.opener) ? " ⚑" : ""
        } | ${o.count} |`
      ),
      "",
    );
    if (sc.repeatedOpeners.length > 0) {
      lines.push(
        `Repeated openers: ${
          sc.repeatedOpeners.map((o) => `"${o}"`).join(", ")
        }.`,
        "",
      );
    }
    if (sc.flaggedOpeners.length > 0) {
      lines.push(
        "⚑ marks openers guide 2.7 asks you to question.",
        "",
      );
    }
  }

  if (r.diff) {
    const body = r.diff.join("\n");
    const f = fence(body);
    lines.push("## Changes", "", `${f}diff`, body, f, "");
  } else if (r.finalDraft !== null) {
    lines.push("## Changes", "", DIFF_OMITTED, "");
  }

  if (r.finalDraft !== null) {
    const f = fence(r.finalDraft);
    lines.push("## Revised draft", "", `${f}markdown`, r.finalDraft, f, "");
  }

  lines.push(`*Generated ${r.generatedAt}*`);
  return lines.join("\n");
}

// =============================================================================
// Report
// =============================================================================

/** Build the report contract from a workflow context. Never throws. */
export async function buildReport(
  context: WorkflowReportContext,
): Promise<EditorialReport> {
  const r: EditorialReport = {
    status: "degraded",
    contentKind: null,
    draft: null,
    guide: null,
    voice: null,
    passes: [],
    selfCheck: null,
    economy: null,
    diff: null,
    finalDraft: null,
    notes: [],
    degraded: false,
    generatedAt: new Date().toISOString(),
  };
  const degrade = (note: string) => {
    r.degraded = true;
    r.notes.push(note);
    return r;
  };

  try {
    const steps = context.stepExecutions ?? [];
    const repo = context.dataRepository;

    const prepareStep = findStep(steps, "prepare", REVIEW_TYPE);
    if (!prepareStep) {
      return degrade("The prepare step is absent or did not succeed.");
    }
    const request = await readStep(repo, prepareStep, "review-request");
    const original = obj(request?.original);
    if (!request || !original) {
      return degrade("The prepare step's request data could not be read.");
    }

    r.contentKind = str(request.contentKind) || null;
    r.draft = {
      source: str(original.source),
      path: str(original.path),
      sha256: str(original.sha256),
      wordCount: num(original.wordCount),
      sentenceCount: num(original.sentenceCount),
      codeBlockCount: num(original.codeBlockCount),
    };
    const guide = obj(request.guide);
    if (guide) r.guide = { file: str(guide.file), sha256: str(guide.sha256) };
    const voice = obj(request.voice);
    if (voice) {
      r.voice = {
        model: str(voice.model),
        hasProfile: voice.hasProfile === true,
        antiPatternCount: Array.isArray(voice.antiPatterns)
          ? voice.antiPatterns.length
          : 0,
        killListCount: Array.isArray(voice.killList)
          ? voice.killList.length
          : 0,
      };
    }
    const sentences = Array.isArray(original.sentences)
      ? original.sentences.map(obj).filter((s): s is Record<string, unknown> =>
        s !== null
      ).map((s) => ({
        text: str(s.text),
        words: num(s.words),
        opener: str(s.opener),
      }))
      : [];
    r.selfCheck = selfCheck(sentences);

    const reviewStep = findStep(steps, "review", CLAUDE_TYPE);
    if (!reviewStep) {
      return degrade(
        "The first-pass review step is absent or did not succeed.",
      );
    }
    const reviewData = await readStep(repo, reviewStep, REVIEW_RESULT);
    if (!reviewData) return degrade("The first-pass result could not be read.");
    const first = toPass("review", reviewData);
    if (typeof first === "string") return degrade(`First pass: ${first}.`);
    r.passes.push(first);

    let finalDraft = first.revisedDraft;
    const recheckStep = findStep(steps, "recheck-review", CLAUDE_TYPE);
    if (recheckStep) {
      const recheckData = await readStep(repo, recheckStep, RECHECK_RESULT);
      const second = recheckData
        ? toPass("recheck", recheckData)
        : "the result could not be read";
      if (typeof second === "string") {
        degrade(`Second pass: ${second}; showing the first pass's revision.`);
      } else {
        r.passes.push(second);
        if (second.revisedDraft) finalDraft = second.revisedDraft;
      }
    } else if (
      context.inputs?.recheck !== false && context.inputs?.recheck !== "false"
    ) {
      degrade(
        "The second-pass step is absent or did not succeed; showing the first pass's revision.",
      );
    }

    const originalText = str(original.text);
    r.finalDraft = finalDraft;
    // Count the original the same way as the revision; the model's wordCount
    // excludes code blocks, and a revision must not grow by its code.
    const originalWords = countWords(originalText);
    const finalWords = countWords(finalDraft);
    r.economy = {
      originalWords,
      finalWords,
      deltaWords: finalWords - originalWords,
      grew: finalWords > originalWords,
    };
    r.diff = lineDiff(originalText, finalDraft);
    if (r.diff === null) {
      r.notes.push(DIFF_OMITTED);
    }
  } catch (err) {
    degrade(
      `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  r.status = !r.degraded
    ? "complete"
    : r.finalDraft !== null
    ? "partial"
    : "degraded";
  return r;
}

/** The `@webframp/editorial-review` workflow-scope report. */
export const report = {
  name: "@webframp/editorial-review",
  description:
    "Editorial review findings grouped by guide section, the sentence-shape self-check, an economy warning when the revision grew, a diff, and the final revised draft.",
  scope: "workflow" as const,
  labels: ["writing", "editorial", "prose"],

  async execute(
    context: WorkflowReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    const r = await buildReport(context);
    context.logger?.info?.(
      "Editorial review report: {status}, {findings} findings",
      {
        status: r.status,
        findings: r.passes.reduce((n, p) => n + p.findings.length, 0),
      },
    );
    let markdown: string;
    try {
      markdown = renderMarkdown(r);
    } catch (err) {
      // The report never throws: fall back to a minimal page over the JSON.
      r.degraded = true;
      r.notes.push(
        `Rendering failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      markdown = [
        "# Editorial review",
        "",
        "> **Degraded:** the markdown could not be rendered; the JSON output is complete.",
        ...r.notes.map((n) => `> - ${oneLine(n)}`),
      ].join("\n");
    }
    return { markdown, json: r as unknown as Record<string, unknown> };
  },
};
