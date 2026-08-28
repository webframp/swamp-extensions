/**
 * GitHub Issue Lifecycle Model for swamp.
 *
 * Tracks issues from open through triage, planning, implementation, PR, and
 * merge. Designed for a solo developer or small team working on GitHub repos.
 * Uses `gh` CLI for all GitHub interactions.
 *
 * State machine:
 * ```
 * opened ──[start]──> triaging
 * triaging ──[triage]──> classified
 * classified ──[plan]──> planned
 * planned ──[iterate]──> planned  (feedback loop)
 * planned ──[approve]──> approved
 * approved ──[implement]──> implementing
 * implementing ──[link_pr]──> pr_open
 * pr_open ──[link_pr]──> pr_open  (idempotent)
 * pr_open ──[pr_failed]──> pr_failed
 * pr_failed ──[link_pr]──> pr_open  (retry)
 * pr_failed ──[implement]──> implementing  (restart)
 * pr_open ──[pr_merged]──> done
 * implementing ──[complete]──> done
 * pr_open ──[complete]──> done
 * Any ──[close]──> closed
 * ```
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const EXTENSION_NAME = "@webframp/github-issue-lifecycle";

// =============================================================================
// Constants
// =============================================================================

/** Valid lifecycle phases. */
const PHASES = [
  "opened",
  "triaging",
  "classified",
  "planned",
  "approved",
  "implementing",
  "pr_open",
  "pr_failed",
  "done",
  "closed",
] as const;

/** Lifecycle phase type — one of the valid phases in the state machine. */
type Phase = typeof PHASES[number];

/** Valid transitions: from → allowed targets */
const TRANSITIONS: Record<string, Phase[]> = {
  opened: ["triaging"],
  triaging: ["classified", "closed"],
  classified: ["planned", "closed"],
  planned: ["planned", "approved", "closed"],
  approved: ["implementing", "closed"],
  implementing: ["pr_open", "done", "closed"],
  pr_open: ["pr_open", "pr_failed", "done", "closed"],
  pr_failed: ["pr_open", "implementing", "closed"],
};

// =============================================================================
// Schemas
// =============================================================================

/** Schema for global arguments: repo, comment/label preferences. */
const GlobalArgsSchema = z.object({
  repo: z.string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "repo must be in owner/name format")
    .describe(
      "GitHub repo in owner/name format (e.g., webframp/swamp-extensions)",
    ),
  postComments: z.boolean().default(true)
    .describe("Post lifecycle transition comments to the GitHub issue"),
  syncLabels: z.boolean().default(true)
    .describe("Sync lifecycle phase as a GitHub label (lifecycle:<phase>)"),
});

/** Parsed global args type. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Zod schema for validating phase enum values. */
const PhaseSchema = z.enum(PHASES);

/** Schema for lifecycle state tracking. */
const StateSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  phase: PhaseSchema.describe("Current lifecycle phase"),
  previousPhase: PhaseSchema.nullable().describe("Previous phase"),
  transitionedAt: z.string().describe("ISO 8601 timestamp of last transition"),
  startedAt: z.string().describe("When lifecycle tracking began"),
  iteration: z.number().describe("Plan iteration count"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Parsed state data type. */
type StateData = z.infer<typeof StateSchema>;

/** Schema for issue context fetched from GitHub. */
const ContextSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  title: z.string().describe("Issue title"),
  body: z.string().describe("Issue body text"),
  author: z.string().describe("Issue author's GitHub login"),
  labels: z.array(z.string()).describe("Labels currently on the issue"),
  assignees: z.array(z.string()).describe(
    "GitHub logins of assignees on the issue",
  ),
  state: z.string().describe("GitHub issue state (e.g. OPEN, CLOSED)"),
  createdAt: z.string().describe("Timestamp the issue was created"),
  updatedAt: z.string().describe("Timestamp the issue was last updated"),
  repo: z.string().describe("Repository the issue belongs to"),
  url: z.string().describe("Full issue URL"),
  fetchedAt: z.string().describe("Timestamp this context was fetched"),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Schema for issue classification after triage. */
const ClassificationSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  kind: z.enum(["bug", "feature", "chore", "security", "docs"]).describe(
    "Category assigned during triage",
  ),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().describe(
    "Priority assigned during triage",
  ),
  component: z.string().optional().describe("Affected component or area"),
  notes: z.string().optional().describe("Triage notes"),
  classifiedAt: z.string().describe("Timestamp the issue was classified"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Schema for implementation plans (versioned). */
const PlanSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  iteration: z.number().describe("Plan version (increments on iterate)"),
  summary: z.string().describe("One-line summary of approach"),
  steps: z.array(z.string()).describe("Implementation steps"),
  risks: z.array(z.string()).optional().describe("Known risks or concerns"),
  feedback: z.string().optional().describe("Feedback from last iteration"),
  createdAt: z.string().describe("Timestamp the plan was created"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Schema for linked pull request metadata. */
const PullRequestSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  prNumber: z.number().nullable().describe("PR number if parseable from URL"),
  prUrl: z.string().describe("Full PR URL"),
  branch: z.string().optional().describe("Branch name"),
  linkedAt: z.string().describe("Timestamp the PR was linked"),
  status: z.enum(["open", "merged", "failed"]).describe(
    "Current status of the linked PR",
  ),
  failureReason: z.string().optional().describe(
    "Why the PR failed CI or review",
  ),
  retryCount: z.number().default(0)
    .describe("Number of times this PR has failed CI/review"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

/** Parsed pull request data type. */
type PullRequestData = z.infer<typeof PullRequestSchema>;

// =============================================================================
// Helpers
// =============================================================================

/** Context provided to each method by the swamp runtime. */
interface MethodContext {
  globalArgs: GlobalArgs;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

/**
 * Build a storage instance name unique across all resource specs on this
 * model. Instance names map directly to storage paths and must not collide
 * across specs — prefixing with the spec name keeps `state-issue-42` and
 * `pullRequest-issue-42` distinct even though they track the same issue.
 */
function instanceName(spec: string, issueNumber: number, suffix = ""): string {
  return `${spec}-issue-${issueNumber}${suffix}`;
}

/** Execute a gh CLI command and return stdout. */
async function runGh(args: string[]): Promise<string> {
  const cmdDesc = `gh ${args.join(" ")}`;
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `${cmdDesc} failed (exit ${output.code}): ${err || "(no output)"}`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Execute gh and parse JSON output. */
async function runGhJson(args: string[]): Promise<unknown> {
  const stdout = await runGh(args);
  try {
    return JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh ${
        args.join(" ")
      } returned output that could not be parsed as JSON: ${msg}`,
      { cause: err },
    );
  }
}

/** Validate a state transition is allowed. */
function assertTransition(current: Phase, target: Phase): void {
  const allowed = TRANSITIONS[current];
  if (!allowed || !allowed.includes(target)) {
    throw new Error(
      `Invalid transition: ${current} → ${target}. ` +
        `Allowed from ${current}: ${allowed?.join(", ") ?? "none"}`,
    );
  }
}

/** Read current state for an issue via the model's stored resources. */
async function readCurrentState(
  ctx: MethodContext,
  issueNumber: number,
): Promise<StateData | null> {
  const data = await ctx.readResource(instanceName("state", issueNumber));
  return data as StateData | null;
}

/**
 * Require current state and validate transition. Returns the current state
 * for propagating startedAt, iteration, etc.
 */
async function requireStateAndTransition(
  ctx: MethodContext,
  issueNumber: number,
  targetPhase: Phase,
): Promise<StateData> {
  const current = await readCurrentState(ctx, issueNumber);
  if (!current) {
    throw new Error(
      `No lifecycle state found for issue #${issueNumber}. Run 'start' first.`,
    );
  }
  assertTransition(current.phase, targetPhase);
  return current;
}

/** Post a comment on the GitHub issue if configured. */
async function postComment(
  repo: string,
  issueNumber: number,
  body: string,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  await runGh([
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    body,
  ]);
}

/** Sync the lifecycle label on the issue if configured. */
async function syncLabel(
  repo: string,
  issueNumber: number,
  newPhase: Phase,
  oldPhase: Phase | null,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const newLabel = `lifecycle:${newPhase}`;
  const addArgs = [
    "issue",
    "edit",
    String(issueNumber),
    "--repo",
    repo,
    "--add-label",
    newLabel,
  ];
  if (oldPhase) {
    addArgs.push("--remove-label", `lifecycle:${oldPhase}`);
  }
  try {
    await runGh(addArgs);
  } catch {
    // Label operations are best-effort
  }
}

// =============================================================================
// Methods
// =============================================================================

/** start — fetch issue context from GitHub, begin tracking. */
async function start(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;

  // start is special: it creates the initial state. If state already exists,
  // we allow re-start only if not in terminal state.
  const existing = await readCurrentState(ctx, args.issue_number);
  if (existing && (existing.phase === "done" || existing.phase === "closed")) {
    throw new Error(
      `Issue #${args.issue_number} is already in terminal state: ${existing.phase}`,
    );
  }

  const issueData = await runGhJson([
    "issue",
    "view",
    String(args.issue_number),
    "--repo",
    repo,
    "--json",
    "number,title,body,author,labels,assignees,state,createdAt,updatedAt,url",
  ]) as Record<string, unknown>;

  const now = new Date().toISOString();

  const contextHandle = await ctx.writeResource(
    "context",
    instanceName("context", args.issue_number),
    {
      issueNumber: args.issue_number,
      title: issueData.title ?? "",
      body: issueData.body ?? "",
      author: (issueData.author as Record<string, string>)?.login ?? "unknown",
      labels: ((issueData.labels as Array<{ name: string }>) ?? []).map(
        (l) => l.name,
      ),
      assignees: ((issueData.assignees as Array<{ login: string }>) ?? []).map(
        (a) => a.login,
      ),
      state: issueData.state ?? "OPEN",
      createdAt: issueData.createdAt ?? now,
      updatedAt: issueData.updatedAt ?? now,
      repo,
      url: issueData.url ?? "",
      fetchedAt: now,

      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "triaging",
      previousPhase: "opened",
      transitionedAt: now,
      startedAt: existing?.startedAt ?? now,
      iteration: existing?.iteration ?? 0,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "triaging",
    existing?.phase ?? null,
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `🔄 **Lifecycle started** — now triaging.`,
    postComments,
  );

  ctx.logger.info("Started lifecycle for issue #{num}", {
    num: args.issue_number,
  });
  return { dataHandles: [contextHandle, stateHandle] };
}

/** triage — classify the issue. */
async function triage(
  args: {
    issue_number: number;
    kind: string;
    priority?: string;
    component?: string;
    notes?: string;
  },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "classified",
  );
  const now = new Date().toISOString();

  const classHandle = await ctx.writeResource(
    "classification",
    instanceName("classification", args.issue_number),
    {
      issueNumber: args.issue_number,
      kind: args.kind,
      priority: args.priority,
      component: args.component,
      notes: args.notes,
      classifiedAt: now,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "classified",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  try {
    await runGh([
      "issue",
      "edit",
      String(args.issue_number),
      "--repo",
      repo,
      "--add-label",
      args.kind,
    ]);
  } catch { /* best-effort */ }

  await syncLabel(
    repo,
    args.issue_number,
    "classified",
    current.phase,
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `📋 **Triaged** as \`${args.kind}\`${
      args.priority ? ` (${args.priority})` : ""
    }${args.component ? ` — component: ${args.component}` : ""}.`,
    postComments,
  );

  ctx.logger.info("Triaged issue #{num} as {kind}", {
    num: args.issue_number,
    kind: args.kind,
  });
  return { dataHandles: [classHandle, stateHandle] };
}

/** plan — record an implementation plan. */
async function plan(
  args: {
    issue_number: number;
    summary: string;
    steps: string[];
    risks?: string[];
    feedback?: string;
  },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "planned",
  );
  const now = new Date().toISOString();
  const iteration = current.iteration + 1;

  const planHandle = await ctx.writeResource(
    "plan",
    instanceName("plan", args.issue_number, `-v${iteration}`),
    {
      issueNumber: args.issue_number,
      iteration,
      summary: args.summary,
      steps: args.steps,
      risks: args.risks,
      feedback: args.feedback,
      createdAt: now,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "planned",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "planned",
    current.phase,
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `📝 **Plan v${iteration}:** ${args.summary}\n\nSteps:\n${
      args.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
    }`,
    postComments,
  );

  ctx.logger.info("Plan v{iter} created for issue #{num}", {
    iter: iteration,
    num: args.issue_number,
  });
  return { dataHandles: [planHandle, stateHandle] };
}

/** iterate — revise the plan with feedback. */
async function iterate(
  args: {
    issue_number: number;
    summary: string;
    steps: string[];
    risks?: string[];
    feedback: string;
  },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "planned",
  );
  const now = new Date().toISOString();
  const iteration = current.iteration + 1;

  const planHandle = await ctx.writeResource(
    "plan",
    instanceName("plan", args.issue_number, `-v${iteration}`),
    {
      issueNumber: args.issue_number,
      iteration,
      summary: args.summary,
      steps: args.steps,
      risks: args.risks,
      feedback: args.feedback,
      createdAt: now,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "planned",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await postComment(
    repo,
    args.issue_number,
    `🔁 **Plan revised (v${iteration}):** ${args.summary}\n\nFeedback: ${args.feedback}`,
    postComments,
  );

  ctx.logger.info("Plan iterated to v{iter} for issue #{num}", {
    iter: iteration,
    num: args.issue_number,
  });
  return { dataHandles: [planHandle, stateHandle] };
}

/** approve — lock the plan and move to approved. */
async function approve(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "approved",
  );
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "approved",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "approved",
    current.phase,
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `✅ **Plan approved** — ready for implementation.`,
    postComments,
  );

  ctx.logger.info("Plan approved for issue #{num}", {
    num: args.issue_number,
  });
  return { dataHandles: [stateHandle] };
}

/** implement — signal that implementation has started. */
async function implement(
  args: { issue_number: number; branch?: string },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "implementing",
  );
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "implementing",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "implementing",
    current.phase,
    syncLabels,
  );
  const branchNote = args.branch ? ` on branch \`${args.branch}\`` : "";
  await postComment(
    repo,
    args.issue_number,
    `🔨 **Implementation started**${branchNote}.`,
    postComments,
  );

  ctx.logger.info("Implementation started for issue #{num}", {
    num: args.issue_number,
  });
  return { dataHandles: [stateHandle] };
}

/** link_pr — associate a PR with this issue. Idempotent. */
async function linkPr(
  args: { issue_number: number; pr_url: string; branch?: string },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "pr_open",
  );
  const now = new Date().toISOString();

  const prMatch = args.pr_url.match(/\/pull\/(\d+)/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

  // Preserve the retry count across a link_pr retry from pr_failed.
  const existingPr = await ctx.readResource(
    instanceName("pullRequest", args.issue_number),
  ) as PullRequestData | null;

  const prHandle = await ctx.writeResource(
    "pullRequest",
    instanceName("pullRequest", args.issue_number),
    {
      issueNumber: args.issue_number,
      prNumber,
      prUrl: args.pr_url,
      branch: args.branch,
      linkedAt: now,
      status: "open",
      retryCount: existingPr?.retryCount ?? 0,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "pr_open",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "pr_open",
    current.phase,
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `🔗 **PR linked:** ${args.pr_url}`,
    postComments,
  );

  ctx.logger.info("PR linked for issue #{num}", { num: args.issue_number });
  return { dataHandles: [prHandle, stateHandle] };
}

/** pr_merged — record the PR was merged, close the issue. */
async function prMerged(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "done",
  );
  const now = new Date().toISOString();

  // Update the pullRequest resource with merged status, carrying forward URL/number
  const existingPr = await ctx.readResource(
    instanceName("pullRequest", args.issue_number),
  ) as PullRequestData | null;
  const prHandle = await ctx.writeResource(
    "pullRequest",
    instanceName("pullRequest", args.issue_number),
    {
      issueNumber: args.issue_number,
      prNumber: existingPr?.prNumber ?? null,
      prUrl: existingPr?.prUrl ?? "",
      branch: existingPr?.branch,
      linkedAt: existingPr?.linkedAt ?? now,
      status: "merged",
      retryCount: existingPr?.retryCount ?? 0,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "done",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(repo, args.issue_number, "done", current.phase, syncLabels);
  await postComment(
    repo,
    args.issue_number,
    `🎉 **PR merged** — issue complete.`,
    postComments,
  );

  try {
    await runGh([
      "issue",
      "close",
      String(args.issue_number),
      "--repo",
      repo,
      "--reason",
      "completed",
    ]);
  } catch { /* best-effort */ }

  ctx.logger.info("PR merged, issue #{num} done", { num: args.issue_number });
  return { dataHandles: [prHandle, stateHandle] };
}

/** pr_failed — record that the PR failed CI or review. */
async function prFailed(
  args: { issue_number: number; reason?: string },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "pr_failed",
  );
  const now = new Date().toISOString();

  // Update pullRequest resource with failed status, carrying forward URL/number
  const existingPr = await ctx.readResource(
    instanceName("pullRequest", args.issue_number),
  ) as PullRequestData | null;
  const prHandle = await ctx.writeResource(
    "pullRequest",
    instanceName("pullRequest", args.issue_number),
    {
      issueNumber: args.issue_number,
      prNumber: existingPr?.prNumber ?? null,
      prUrl: existingPr?.prUrl ?? "",
      branch: existingPr?.branch,
      linkedAt: existingPr?.linkedAt ?? now,
      status: "failed",
      failureReason: args.reason,
      retryCount: (existingPr?.retryCount ?? 0) + 1,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "pr_failed",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "pr_failed",
    current.phase,
    syncLabels,
  );
  const reason = args.reason ? `: ${args.reason}` : "";
  await postComment(
    repo,
    args.issue_number,
    `❌ **PR failed**${reason}. Ready for retry.`,
    postComments,
  );

  ctx.logger.info("PR failed for issue #{num}", { num: args.issue_number });
  return { dataHandles: [prHandle, stateHandle] };
}

/** complete — mark done without the full PR ceremony. */
async function complete(
  args: { issue_number: number; close_issue?: boolean },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const current = await requireStateAndTransition(
    ctx,
    args.issue_number,
    "done",
  );
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "done",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(repo, args.issue_number, "done", current.phase, syncLabels);
  await postComment(repo, args.issue_number, `✅ **Complete.**`, postComments);

  if (args.close_issue !== false) {
    try {
      await runGh([
        "issue",
        "close",
        String(args.issue_number),
        "--repo",
        repo,
        "--reason",
        "completed",
      ]);
    } catch { /* best-effort */ }
  }

  ctx.logger.info("Issue #{num} completed", { num: args.issue_number });
  return { dataHandles: [stateHandle] };
}

/** close — abandon from any state. */
async function close(
  args: { issue_number: number; reason?: string },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  // close is special: allowed from any non-terminal state, but requires
  // that a lifecycle has been started.
  const current = await readCurrentState(ctx, args.issue_number);
  if (!current) {
    throw new Error(
      `No lifecycle state found for issue #${args.issue_number}. Run 'start' first.`,
    );
  }
  if (current.phase === "done" || current.phase === "closed") {
    throw new Error(
      `Issue #${args.issue_number} is already in terminal state: ${current.phase}`,
    );
  }

  const stateHandle = await ctx.writeResource(
    "state",
    instanceName("state", args.issue_number),
    {
      issueNumber: args.issue_number,
      phase: "closed",
      previousPhase: current.phase,
      transitionedAt: now,
      startedAt: current.startedAt,
      iteration: current.iteration,

      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "closed",
    current.phase,
    syncLabels,
  );
  const reason = args.reason ? `: ${args.reason}` : "";
  await postComment(
    repo,
    args.issue_number,
    `🚫 **Closed**${reason}.`,
    postComments,
  );

  try {
    await runGh([
      "issue",
      "close",
      String(args.issue_number),
      "--repo",
      repo,
      "--reason",
      "not_planned",
    ]);
  } catch { /* best-effort */ }

  ctx.logger.info("Issue #{num} closed", { num: args.issue_number });
  return { dataHandles: [stateHandle] };
}

/** status — read-only: show current state. No transition. */
async function status(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const startMs = Date.now();
  const { repo } = ctx.globalArgs;

  const issueData = await runGhJson([
    "issue",
    "view",
    String(args.issue_number),
    "--repo",
    repo,
    "--json",
    "number,title,body,author,state,labels,assignees,createdAt,updatedAt,url",
  ]) as Record<string, unknown>;

  const handle = await ctx.writeResource(
    "context",
    instanceName("context", args.issue_number),
    {
      issueNumber: args.issue_number,
      title: issueData.title ?? "",
      body: issueData.body ?? "",
      author: (issueData.author as Record<string, string>)?.login ?? "",
      labels: ((issueData.labels as Array<{ name: string }>) ?? []).map(
        (l) => l.name,
      ),
      assignees: ((issueData.assignees as Array<{ login: string }>) ?? []).map(
        (a) => a.login,
      ),
      state: issueData.state ?? "OPEN",
      createdAt: (issueData.createdAt as string) ?? "",
      updatedAt: (issueData.updatedAt as string) ?? "",
      repo,
      url: (issueData.url as string) ?? "",
      fetchedAt: new Date().toISOString(),

      durationMs: Date.now() - startMs,
      collectedBy: EXTENSION_NAME,
    },
  );

  ctx.logger.info("Status check for issue #{num}", {
    num: args.issue_number,
  });
  return { dataHandles: [handle] };
}

// =============================================================================
// Model Export
// =============================================================================

export const model = {
  type: "@webframp/github-issue-lifecycle" as const,
  version: "2026.08.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Current lifecycle phase and transition metadata.",
      schema: StateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    context: {
      description: "Issue context fetched from GitHub.",
      schema: ContextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    classification: {
      description: "Issue classification (kind, priority, component).",
      schema: ClassificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    plan: {
      description: "Implementation plan (versioned on iterate).",
      schema: PlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    pullRequest: {
      description: "Linked pull request metadata.",
      schema: PullRequestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    start: {
      description:
        "Fetch issue context from GitHub and begin lifecycle tracking.",
      arguments: z.object({
        issue_number: z.number().int().min(1)
          .describe("GitHub issue number"),
      }),
      execute: start,
    },
    triage: {
      description: "Classify the issue and set labels.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        kind: z.enum(["bug", "feature", "chore", "security", "docs"])
          .describe("Category to assign during triage"),
        priority: z.enum(["critical", "high", "medium", "low"]).optional()
          .describe("Priority to assign during triage"),
        component: z.string().optional().describe(
          "Affected component or area",
        ),
        notes: z.string().optional().describe("Triage notes"),
      }),
      execute: triage,
    },
    plan: {
      description: "Record an implementation plan.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        summary: z.string().describe("One-line summary of approach"),
        steps: z.array(z.string()).describe("Implementation steps"),
        risks: z.array(z.string()).optional().describe(
          "Known risks or concerns",
        ),
        feedback: z.string().optional().describe(
          "Feedback from the last iteration",
        ),
      }),
      execute: plan,
    },
    iterate: {
      description: "Revise the plan with feedback (bumps iteration).",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        summary: z.string().describe(
          "One-line summary of the revised approach",
        ),
        steps: z.array(z.string()).describe("Revised implementation steps"),
        risks: z.array(z.string()).optional().describe(
          "Known risks or concerns",
        ),
        feedback: z.string().describe("What changed and why"),
      }),
      execute: iterate,
    },
    approve: {
      description: "Lock the plan — ready for implementation.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
      }),
      execute: approve,
    },
    implement: {
      description: "Signal that implementation has started.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        branch: z.string().optional()
          .describe("Working branch name if known"),
      }),
      execute: implement,
    },
    link_pr: {
      description: "Associate a PR URL with the issue. Idempotent.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        pr_url: z.string().url().describe("Full PR URL"),
        branch: z.string().optional(),
      }),
      execute: linkPr,
    },
    pr_merged: {
      description: "Record PR merge and close the issue.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
      }),
      execute: prMerged,
    },
    pr_failed: {
      description: "Record that the PR failed CI or review.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        reason: z.string().optional().describe(
          "Why the PR failed CI or review",
        ),
      }),
      execute: prFailed,
    },
    complete: {
      description: "Mark done without full PR flow.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        close_issue: z.boolean().optional()
          .describe("Close the GitHub issue (default: true)"),
      }),
      execute: complete,
    },
    close: {
      description: "Abandon the issue from any state.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
        reason: z.string().optional().describe("Why the issue was closed"),
      }),
      execute: close,
    },
    status: {
      description: "Read-only: refresh and show current issue state.",
      arguments: z.object({
        issue_number: z.number().int().min(1).describe("GitHub issue number"),
      }),
      execute: status,
    },
  },
};

// Re-export for testing
/** Validates a transition is allowed in the state machine. */
export { assertTransition };
/** Read current state for an issue from stored resources. */
export { readCurrentState };
/** Valid transition map. */
export { TRANSITIONS };
/** Build a per-spec, collision-free storage instance name. */
export { instanceName };
/** Method context interface for consumers. */
export type { MethodContext };
/** Lifecycle phase type. */
export type { Phase };
