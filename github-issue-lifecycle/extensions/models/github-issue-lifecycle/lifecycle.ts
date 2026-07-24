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

// =============================================================================
// Constants
// =============================================================================

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

const GlobalArgsSchema = z.object({
  repo: z.string()
    .describe(
      "GitHub repo in owner/name format (e.g., webframp/swamp-extensions)",
    ),
  postComments: z.boolean().default(true)
    .describe("Post lifecycle transition comments to the GitHub issue"),
  syncLabels: z.boolean().default(true)
    .describe("Sync lifecycle phase as a GitHub label (lifecycle:<phase>)"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PhaseSchema = z.enum(PHASES);

const StateSchema = z.object({
  issueNumber: z.number().describe("GitHub issue number"),
  phase: PhaseSchema.describe("Current lifecycle phase"),
  previousPhase: PhaseSchema.nullable().describe("Previous phase"),
  transitionedAt: z.string().describe("ISO 8601 timestamp of last transition"),
  startedAt: z.string().describe("When lifecycle tracking began"),
  iteration: z.number().describe("Plan iteration count"),
});

const ContextSchema = z.object({
  issueNumber: z.number(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  repo: z.string(),
  url: z.string(),
  fetchedAt: z.string(),
});

const ClassificationSchema = z.object({
  issueNumber: z.number(),
  kind: z.enum(["bug", "feature", "chore", "security", "docs"]),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  component: z.string().optional().describe("Affected component or area"),
  notes: z.string().optional().describe("Triage notes"),
  classifiedAt: z.string(),
});

const PlanSchema = z.object({
  issueNumber: z.number(),
  iteration: z.number().describe("Plan version (increments on iterate)"),
  summary: z.string().describe("One-line summary of approach"),
  steps: z.array(z.string()).describe("Implementation steps"),
  risks: z.array(z.string()).optional().describe("Known risks or concerns"),
  feedback: z.string().optional().describe("Feedback from last iteration"),
  createdAt: z.string(),
});

const PullRequestSchema = z.object({
  issueNumber: z.number(),
  prNumber: z.number().nullable().describe("PR number if parseable from URL"),
  prUrl: z.string().describe("Full PR URL"),
  branch: z.string().optional().describe("Branch name"),
  linkedAt: z.string(),
  status: z.enum(["open", "merged", "failed"]),
  failureReason: z.string().optional(),
});

// =============================================================================
// Helpers
// =============================================================================

interface MethodContext {
  globalArgs: GlobalArgs;
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

/** Execute a gh CLI command and return stdout. */
async function runGh(args: string[]): Promise<string> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`gh failed: ${err}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

/** Execute gh and parse JSON output. */
async function runGhJson(args: string[]): Promise<unknown> {
  const stdout = await runGh(args);
  return JSON.parse(stdout);
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
    // Label operations are best-effort — don't fail the transition
  }
}

/**
 * Read current state from the model's stored resources. Returns null if
 * no lifecycle has been started for this issue yet.
 */
function readCurrentState(
  storedResources: Array<{ specName: string; data: unknown }>,
  issueNumber: number,
): z.infer<typeof StateSchema> | null {
  const stateResources = storedResources.filter(
    (r) =>
      r.specName === "state" &&
      (r.data as Record<string, unknown>).issueNumber === issueNumber,
  );
  if (stateResources.length === 0) return null;
  // Most recent (last written) wins
  return stateResources[stateResources.length - 1].data as z.infer<
    typeof StateSchema
  >;
}

// =============================================================================
// Methods
// =============================================================================

/** start — fetch issue context from GitHub, begin tracking. */
async function start(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const { repo, postComments, syncLabels } = ctx.globalArgs;

  // Fetch issue from GitHub
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

  // Store context
  const contextHandle = await ctx.writeResource(
    "context",
    `issue-${args.issue_number}`,
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
    },
  );

  // Store initial state
  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "triaging",
      previousPhase: "opened",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(repo, args.issue_number, "triaging", null, syncLabels);
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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  // Store classification
  const classHandle = await ctx.writeResource(
    "classification",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      kind: args.kind,
      priority: args.priority,
      component: args.component,
      notes: args.notes,
      classifiedAt: now,
    },
  );

  // Transition state
  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "classified",
      previousPhase: "triaging",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  // Add kind label to the issue
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
    "triaging",
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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();
  // Iteration is tracked: first plan = 1, each iterate bumps it
  const iteration = 1;

  const planHandle = await ctx.writeResource(
    "plan",
    `issue-${args.issue_number}-v${iteration}`,
    {
      issueNumber: args.issue_number,
      iteration,
      summary: args.summary,
      steps: args.steps,
      risks: args.risks,
      feedback: args.feedback,
      createdAt: now,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "planned",
      previousPhase: "classified",
      transitionedAt: now,
      startedAt: now,
      iteration,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "planned",
    "classified",
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

  ctx.logger.info("Plan created for issue #{num}", {
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
    iteration: number;
  },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const { repo, postComments } = ctx.globalArgs;
  const now = new Date().toISOString();

  const planHandle = await ctx.writeResource(
    "plan",
    `issue-${args.issue_number}-v${args.iteration}`,
    {
      issueNumber: args.issue_number,
      iteration: args.iteration,
      summary: args.summary,
      steps: args.steps,
      risks: args.risks,
      feedback: args.feedback,
      createdAt: now,
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "planned",
      previousPhase: "planned",
      transitionedAt: now,
      startedAt: now,
      iteration: args.iteration,
    },
  );

  await postComment(
    repo,
    args.issue_number,
    `🔁 **Plan revised (v${args.iteration}):** ${args.summary}\n\nFeedback: ${args.feedback}`,
    postComments,
  );

  ctx.logger.info("Plan iterated to v{iter} for issue #{num}", {
    iter: args.iteration,
    num: args.issue_number,
  });
  return { dataHandles: [planHandle, stateHandle] };
}

/** approve — lock the plan and move to approved. */
async function approve(
  args: { issue_number: number },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "approved",
      previousPhase: "planned",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "approved",
    "planned",
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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "implementing",
      previousPhase: "approved",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "implementing",
    "approved",
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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  // Try to extract PR number from URL
  const prMatch = args.pr_url.match(/\/pull\/(\d+)/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

  const prHandle = await ctx.writeResource(
    "pullRequest",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      prNumber,
      prUrl: args.pr_url,
      branch: args.branch,
      linkedAt: now,
      status: "open",
    },
  );

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "pr_open",
      previousPhase: "implementing",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "pr_open",
    "implementing",
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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "done",
      previousPhase: "pr_open",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(repo, args.issue_number, "done", "pr_open", syncLabels);
  await postComment(
    repo,
    args.issue_number,
    `🎉 **PR merged** — issue complete.`,
    postComments,
  );

  // Close the issue
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
  } catch { /* best-effort — may already be closed */ }

  ctx.logger.info("PR merged, issue #{num} done", { num: args.issue_number });
  return { dataHandles: [stateHandle] };
}

/** pr_failed — record that the PR failed CI or review. */
async function prFailed(
  args: { issue_number: number; reason?: string },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "pr_failed",
      previousPhase: "pr_open",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "pr_failed",
    "pr_open",
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
  return { dataHandles: [stateHandle] };
}

/** complete — mark done without the full PR ceremony. */
async function complete(
  args: { issue_number: number; close_issue?: boolean },
  ctx: MethodContext,
): Promise<{ dataHandles: { name: string }[] }> {
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "done",
      previousPhase: "implementing",
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(
    repo,
    args.issue_number,
    "done",
    "implementing",
    syncLabels,
  );
  await postComment(
    repo,
    args.issue_number,
    `✅ **Complete.**`,
    postComments,
  );

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
  const { repo, postComments, syncLabels } = ctx.globalArgs;
  const now = new Date().toISOString();

  const stateHandle = await ctx.writeResource(
    "state",
    `issue-${args.issue_number}`,
    {
      issueNumber: args.issue_number,
      phase: "closed",
      previousPhase: null,
      transitionedAt: now,
      startedAt: now,
      iteration: 0,
    },
  );

  await syncLabel(repo, args.issue_number, "closed", null, syncLabels);
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
  const { repo } = ctx.globalArgs;

  // Refresh issue from GitHub
  const issueData = await runGhJson([
    "issue",
    "view",
    String(args.issue_number),
    "--repo",
    repo,
    "--json",
    "number,title,state,labels,assignees,updatedAt,url",
  ]) as Record<string, unknown>;

  const handle = await ctx.writeResource(
    "context",
    `issue-${args.issue_number}-status`,
    {
      issueNumber: args.issue_number,
      title: issueData.title ?? "",
      body: "",
      author: "",
      labels: ((issueData.labels as Array<{ name: string }>) ?? []).map(
        (l) => l.name,
      ),
      assignees: ((issueData.assignees as Array<{ login: string }>) ?? []).map(
        (a) => a.login,
      ),
      state: issueData.state ?? "OPEN",
      createdAt: "",
      updatedAt: issueData.updatedAt ?? "",
      repo,
      url: issueData.url ?? "",
      fetchedAt: new Date().toISOString(),
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

/** GitHub Issue Lifecycle model. */
export const model = {
  type: "@webframp/github-issue-lifecycle" as const,
  version: "2026.07.24.1",
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
        issue_number: z.number().int().min(1),
        kind: z.enum(["bug", "feature", "chore", "security", "docs"]),
        priority: z.enum(["critical", "high", "medium", "low"]).optional(),
        component: z.string().optional(),
        notes: z.string().optional(),
      }),
      execute: triage,
    },
    plan: {
      description: "Record an implementation plan.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        summary: z.string().describe("One-line summary of approach"),
        steps: z.array(z.string()).describe("Implementation steps"),
        risks: z.array(z.string()).optional(),
        feedback: z.string().optional(),
      }),
      execute: plan,
    },
    iterate: {
      description: "Revise the plan with feedback (bumps iteration).",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        summary: z.string(),
        steps: z.array(z.string()),
        risks: z.array(z.string()).optional(),
        feedback: z.string().describe("What changed and why"),
        iteration: z.number().int().min(2),
      }),
      execute: iterate,
    },
    approve: {
      description: "Lock the plan — ready for implementation.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
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
        issue_number: z.number().int().min(1),
      }),
      execute: prMerged,
    },
    pr_failed: {
      description: "Record that the PR failed CI or review.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        reason: z.string().optional(),
      }),
      execute: prFailed,
    },
    complete: {
      description: "Mark done without full PR flow.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        close_issue: z.boolean().optional()
          .describe("Close the GitHub issue (default: true)"),
      }),
      execute: complete,
    },
    close: {
      description: "Abandon the issue from any state.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
        reason: z.string().optional(),
      }),
      execute: close,
    },
    status: {
      description: "Read-only: refresh and show current issue state.",
      arguments: z.object({
        issue_number: z.number().int().min(1),
      }),
      execute: status,
    },
  },
};

// Re-export helpers for testing
export { assertTransition, TRANSITIONS };
// Re-export unused helpers to avoid lint warnings
export type { Phase };
export { readCurrentState };
