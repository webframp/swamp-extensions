/**
 * Report: @webframp/adopt-decision-report (method scope).
 *
 * A default report of the adopt model type. After `decide` it renders what
 * the operator reads before approving the observe step: sweep coverage and
 * gaps, the jev batch outcome, dispositions with who decided them, the
 * observe waves, and high-risk findings. After a sweep it
 * renders the plan's coverage. After any other method it records that there
 * was nothing to render. It never throws: anything it cannot read is
 * reported as unavailable.
 *
 * SPDX-License-Identifier: Apache-2.0
 * @module
 */

/** A reference to data produced by the method execution. */
interface DataHandle {
  name: string;
  version?: number;
}

/** The subset of the data repository this report reads. */
interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/** Context provided to a method-scope report by the swamp runtime. */
interface MethodReportContext {
  modelType: unknown;
  modelId: string;
  methodName?: string;
  dataHandles?: DataHandle[];
  dataRepository: DataRepository;
  logger?: { info?: (msg: string, props: Record<string, unknown>) => void };
}

/** The decision fields this report renders. */
interface Decision {
  scope: string;
  planName: string;
  region: string;
  stackName: string | null;
  judgement: {
    status: string;
    model: string | null;
    requested: number;
    answered: number;
    failed: number;
    overflow: number;
  };
  options: { minConfidence: number };
  decisions: Array<{
    id: string;
    cfnType: string;
    disposition: string;
    decidedBy: string;
    reason: string;
    jev: { disposition: string | null; confidence: number | null } | null;
  }>;
  waves: Array<{ wave: number; candidates: string[] }>;
  findings: Array<{
    id: string;
    cfnType: string;
    disposition: string;
    risk: number;
    riskLevel: string | null;
  }>;
  warnings: string[];
  summary: {
    total: number;
    alreadyManaged: number;
    byDisposition: Record<string, number>;
    byDecidedBy: Record<string, number>;
  };
}

/** The plan coverage fields this report renders. */
interface PlanCoverage {
  truncated: boolean;
  coverage: {
    typesRequested: string[];
    typesSwept: string[];
    gaps: Array<{ cfnType: string; reason: string; detail: string }>;
    truncatedTypes: string[];
    readFailures: number;
    warnings: string[];
  };
}

/** Escape pipe characters and newlines for a markdown table cell. */
function cell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function readJson(
  context: MethodReportContext,
  name: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      name,
      version,
    );
    if (!raw) return null;
    const parsed = JSON.parse(new TextDecoder().decode(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isDecision(value: Record<string, unknown> | null): boolean {
  return !!value && Array.isArray(value.decisions) &&
    value.judgement !== null && typeof value.judgement === "object" &&
    Array.isArray(value.waves);
}

const JUDGEMENT_TEXT: Record<string, string> = {
  used: "jev answered",
  disabled: "judge input off; unsettled candidates go to a human",
  unavailable:
    "no jev batch reached decide; unsettled candidates go to a human",
  capped: "the judge cap is 0; unsettled candidates go to a human",
  mismatched: "jev's batch was for a different candidate set and was ignored",
  "not-needed": "nothing needed judging",
};

/** Coverage and gaps as markdown lines. */
function renderCoverage(plan: PlanCoverage): string[] {
  const c = plan.coverage;
  const out = [
    `Swept ${c.typesSwept.length} of ${c.typesRequested.length} types. ` +
    `Read failures: ${c.readFailures}.` +
    (plan.truncated
      ? ` Truncated: ${c.truncatedTypes.map(cell).join(", ")}.`
      : ""),
  ];
  if (c.gaps.length > 0) {
    out.push("", "| Type | Gap | Detail |", "|---|---|---|");
    for (const g of c.gaps) {
      out.push(
        `| ${cell(g.cfnType)} | ${cell(g.reason)} | ${cell(g.detail)} |`,
      );
    }
  }
  for (const w of c.warnings) out.push(`\n- ${cell(w)}`);
  out.push("");
  return out;
}

/** Render a plan's coverage on its own, after a sweep. */
export function renderPlan(name: string, plan: PlanCoverage): string {
  return [
    `# Adoption plan: ${cell(name)}\n`,
    "## Coverage\n",
    ...renderCoverage(plan),
  ].join("\n");
}

function isPlan(value: Record<string, unknown> | null): boolean {
  return !!value && Array.isArray(value.candidates) &&
    typeof value.coverage === "object" && value.coverage !== null;
}

/** Render the decision and the plan's coverage as markdown. */
export function renderDecision(
  decision: Decision,
  plan: PlanCoverage | null,
): string {
  const out: string[] = [];
  const where = decision.stackName
    ? `stack ${decision.stackName}`
    : `region ${decision.region}`;
  out.push(`# Adoption decision: ${cell(where)}\n`);

  const s = decision.summary;
  out.push("| | Count |", "|---|---|");
  out.push(`| Candidates | ${s.total} |`);
  out.push(`| Already swamp-managed | ${s.alreadyManaged} |`);
  for (const [d, n] of Object.entries(s.byDisposition).sort()) {
    out.push(`| ${cell(d)} | ${n} |`);
  }
  out.push("");

  const j = decision.judgement;
  out.push("## Judgement\n");
  out.push(
    `${JUDGEMENT_TEXT[j.status] ?? j.status}${
      j.model ? ` (${cell(j.model)})` : ""
    }. Sent ${j.requested}, answered ${j.answered}, failed ${j.failed}, ` +
      `over the cap ${j.overflow}.`,
  );
  const decidedBy = Object.entries(s.byDecidedBy).sort()
    .map(([k, n]) => `${k} ${n}`).join(", ");
  if (decidedBy) out.push(`\nDecided by: ${decidedBy}.`);
  const gated =
    decision.decisions.filter((d) =>
      d.decidedBy === "rule" && d.jev?.confidence !== null &&
      d.jev?.confidence !== undefined &&
      d.jev.confidence < decision.options.minConfidence
    ).length;
  if (gated > 0) {
    out.push(
      `\n${gated} jev answers fell below the ${decision.options.minConfidence} ` +
        "confidence gate and went to a human.",
    );
  }
  out.push("");

  if (plan) {
    out.push("## Coverage\n", ...renderCoverage(plan));
  } else {
    out.push("## Coverage\n", "The plan could not be read.\n");
  }

  out.push("## High-risk findings\n");
  if (decision.findings.length === 0) {
    out.push(
      j.status === "used"
        ? "None at or above the risk threshold.\n"
        : "Not assessed: jev did not judge this plan.\n",
    );
  } else {
    out.push("| Resource | Type | Risk | Disposition |", "|---|---|---|---|");
    for (const f of decision.findings) {
      out.push(
        `| ${cell(f.id)} | ${cell(f.cfnType)} | ${
          cell(f.riskLevel ?? f.risk.toFixed(2))
        } | ${cell(f.disposition)} |`,
      );
    }
    out.push("");
  }

  out.push("## Observe waves\n");
  if (decision.waves.length === 0) {
    out.push("Nothing to observe.\n");
  } else {
    out.push("| Wave | Candidates |", "|---|---|");
    for (const w of decision.waves) {
      const shown = w.candidates.slice(0, 5).map(cell).join(", ");
      const more = w.candidates.length > 5
        ? `, and ${w.candidates.length - 5} more`
        : "";
      out.push(`| ${w.wave} | ${shown}${more} |`);
    }
    out.push("");
  }

  const human = decision.decisions.filter((d) =>
    d.disposition === "needs-human"
  );
  if (human.length > 0) {
    out.push("## Needs a human\n", "| Reason | Count |", "|---|---|");
    const byReason = new Map<string, number>();
    for (const d of human) {
      const reason = d.reason.replace(/\d+\.\d+/g, "n");
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    for (
      const [reason, n] of [...byReason].sort((a, b) =>
        b[1] - a[1] || a[0].localeCompare(b[0])
      )
    ) {
      out.push(`| ${cell(reason)} | ${n} |`);
    }
    out.push("");
  }

  if (decision.warnings.length > 0) {
    out.push("## Warnings\n");
    for (const w of decision.warnings) out.push(`- ${cell(w)}`);
    out.push("");
  }

  out.push(
    "Full provenance for every candidate: " +
      `\`swamp data get <model> decision-${decision.planName} --json\`.`,
  );
  return out.join("\n");
}

/** Read the method's handles and render a decision, a plan, or a note. */
async function renderReport(
  context: MethodReportContext,
): Promise<{ markdown: string; json: Record<string, unknown> }> {
  let decision: Decision | null = null;
  let sweptPlan: { name: string; plan: PlanCoverage } | null = null;
  for (const handle of context.dataHandles ?? []) {
    if (!handle?.name || handle.name.startsWith("report-")) continue;
    const data = await readJson(context, handle.name, handle.version);
    if (isDecision(data)) {
      decision = data as unknown as Decision;
      break;
    }
    if (!sweptPlan && isPlan(data)) {
      sweptPlan = {
        name: handle.name,
        plan: data as unknown as PlanCoverage,
      };
    }
  }
  if (!decision && sweptPlan) {
    return {
      markdown: renderPlan(sweptPlan.name, sweptPlan.plan),
      json: {
        available: true,
        kind: "plan",
        planName: sweptPlan.name,
        gaps: sweptPlan.plan.coverage.gaps,
        truncated: sweptPlan.plan.truncated,
      },
    };
  }
  if (!decision) {
    return {
      markdown: `# Adoption decision\n\n${
        cell(context.methodName ?? "This method")
      } wrote no adoptionPlan or adoptionDecision resource; nothing to render.`,
      json: { available: false },
    };
  }
  const planData = await readJson(context, decision.planName);
  const plan = planData && typeof planData.coverage === "object"
    ? planData as unknown as PlanCoverage
    : null;
  context.logger?.info?.("Adoption decision report rendered", {
    planName: decision.planName,
    findings: decision.findings.length,
  });
  return {
    markdown: renderDecision(decision, plan),
    json: {
      available: true,
      kind: "decision",
      planName: decision.planName,
      judgement: decision.judgement,
      summary: decision.summary,
      waves: decision.waves.map((w) => ({
        wave: w.wave,
        count: w.candidates.length,
      })),
      findings: decision.findings,
      gaps: plan?.coverage.gaps ?? null,
      warnings: decision.warnings,
    },
  };
}

/** The `@webframp/adopt-decision-report` method-scope report. */
export const report = {
  name: "@webframp/adopt-decision-report",
  description:
    "Renders an adoption decision after `decide`: coverage and gaps, the " +
    "jev outcome, dispositions and who decided them, observe waves, and " +
    "high-risk findings",
  scope: "method" as const,
  labels: ["aws", "adoption", "brownfield", "decision"],

  async execute(
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> {
    try {
      return await renderReport(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        markdown: `# Adoption decision\n\nThe report could not render: ${
          cell(message)
        }`,
        json: { available: false, error: message },
      };
    }
  },
};
