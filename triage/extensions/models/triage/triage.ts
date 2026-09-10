// SPDX-License-Identifier: Apache-2.0
import { z } from "npm:zod@4.4.3";

const text = z.string().trim().min(1);
const ProviderSchema = z.enum(["github", "gitlab", "swamp_club"]);
const TargetSchema = z.object({
  provider: ProviderSchema,
  kind: z.enum(["issue", "pull_request", "merge_request", "lab_issue"]),
  canonicalUrl: z.url(),
  host: text,
  repository: z.string().optional(),
  project: z.string().optional(),
  iid: z.number().int().positive(),
}).strict();
const ReviewPolicySchema = z.object({
  maxChangedFiles: z.number().int().min(1).max(500).default(50),
  maxChangedLines: z.number().int().min(1).max(50000).default(2400),
  maxSanitizedInputBytes: z.number().int().min(1024).max(1048576).default(
    204800,
  ),
  maxReviewCycles: z.number().int().min(1).max(20).default(7),
  blockingSeverities: z.array(z.enum(["critical", "high", "medium", "low"]))
    .min(1).default(["critical", "high"]),
  excludePathPatterns: z.array(text).default([
    "**/package-lock.json",
    "**/deno.lock",
    "**/node_modules/**",
    "**/vendor/**",
    "**/dist/**",
    "**/generated/**",
  ]),
}).strict();
const GlobalArgsSchema = z.object({
  allowedTargets: z.object({
    github: z.object({ repositoryPatterns: z.array(text).min(1) }),
    gitlab: z.object({ hosts: z.array(text).min(1) }),
    swampClub: z.object({ hosts: z.array(text).min(1) }),
  }).strict(),
  reviewPolicy: ReviewPolicySchema.default({
    maxChangedFiles: 50,
    maxChangedLines: 2400,
    maxSanitizedInputBytes: 204800,
    maxReviewCycles: 7,
    blockingSeverities: ["critical", "high"],
    excludePathPatterns: [
      "**/package-lock.json",
      "**/deno.lock",
      "**/node_modules/**",
      "**/vendor/**",
      "**/dist/**",
      "**/generated/**",
    ],
  }),
  verificationProfiles: z.array(
    z.object({
      provider: z.enum(["github", "gitlab"]),
      repository: text,
      required: z.array(text).min(1),
    }).strict(),
  ).min(1),
}).strict();
const SanitizedTextSchema = z.object({
  contextId: text,
  text: z.string(),
  truncated: z.boolean(),
}).strict();
const ContextSchema = z.object({
  schemaVersion: z.literal(1),
  target: TargetSchema,
  fetchedAt: z.string(),
  sourceRevision: text,
  sourceUpdatedAt: z.string().optional(),
  title: text,
  body: SanitizedTextSchema,
  state: z.enum(["open", "closed", "merged", "unknown"]),
  author: z.string().optional(),
  labels: z.array(z.string()),
  conversation: z.array(
    z.object({
      contextId: text,
      author: z.string().optional(),
      createdAt: z.string().optional(),
      body: SanitizedTextSchema,
    }).strict(),
  ),
  truncation: z.array(z.object({ contextId: text, reason: text }).strict()),
}).strict();
const AssessmentSchema = z.object({
  schemaVersion: z.literal(1),
  contextHash: text,
  targetKind: z.enum(["issue", "change"]),
  classification: z.enum([
    "bug",
    "feature",
    "question",
    "documentation",
    "maintenance",
    "security",
    "review",
    "unknown",
  ]),
  priority: z.enum(["critical", "high", "medium", "low", "unknown"]),
  disposition: z.enum([
    "reroute_to_github",
    "needs_author_feedback",
    "review",
    "retry_ci",
    "close",
    "defer",
    "dismiss",
    "monitor",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  summary: text,
  evidence: z.array(z.object({ contextId: text, claim: text }).strict()),
  questions: z.array(z.string()),
  recommendedNextAction: text,
  securitySignal: z.enum(["none", "possible", "confirmed"]),
}).strict();
const ActionSchema = z.object({
  id: text,
  type: z.enum([
    "github.create_issue",
    "github.add_issue_comment",
    "github.close_issue",
    "github.retry_workflow_run",
    "gitlab.post_review",
    "gitlab.post_inline_review",
    "swamp_club.post_ripple",
  ]),
  payload: z.record(z.string(), z.unknown()),
  dependsOn: z.array(text),
  idempotencyKey: text,
  verify: z.record(z.string(), z.unknown()),
}).strict();
const BundleSchema = z.object({
  schemaVersion: z.literal(1),
  id: text,
  sourceRevision: text,
  assessmentHash: text,
  voiceProfile: z.object({ dataVersion: text, contentHash: text }).strict(),
  actions: z.array(ActionSchema).min(1),
  bundleHash: text,
}).strict();
const ApprovalBindingSchema = z.object({
  bundleHash: text,
  assessmentHash: text,
  sourceRevision: text,
  approvedActionIds: z.array(text).min(1),
  actor: z.literal("Sean"),
  approvedAt: z.string(),
}).strict();
const AuthorizedActionSchema = z.object({
  bundleHash: text,
  actionId: text,
  provider: ProviderSchema,
  methodName: text,
  payload: z.record(z.string(), z.unknown()),
  verify: z.record(z.string(), z.unknown()),
  authorizedAt: z.string(),
}).strict();

type Provider = z.infer<typeof ProviderSchema>;
type Action = z.infer<typeof ActionSchema>;
type Context = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: { info: (message: string, props: Record<string, unknown>) => void };
};

// Object.entries enumerates own properties set to `undefined` (e.g. the
// `{...payload, sourceRevision: undefined}` spread used to compute a
// canonical hash excluding a field). Those keys serialize as the literal
// text "undefined", not an absent key — internally consistent since every
// caller uses this same function to both produce and verify hashes.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function requireResource<T extends z.ZodType>(
  context: Context,
  name: string,
  schema: T,
  description: string,
): Promise<z.infer<T>> {
  const resource = await context.readResource(name);
  if (!resource) throw new Error(`Missing persisted ${description}: ${name}`);
  return schema.parse(resource);
}
function allowed(
  target: { provider: Provider; host: string; repository?: string },
  config: z.infer<typeof GlobalArgsSchema>,
): boolean {
  if (target.provider === "github") {
    return !!target.repository &&
      config.allowedTargets.github.repositoryPatterns.some((p) =>
        p.endsWith("/*")
          ? target.repository!.startsWith(p.slice(0, -1))
          : target.repository === p
      );
  }
  if (target.provider === "gitlab") {
    return config.allowedTargets.gitlab.hosts.includes(target.host);
  }
  return config.allowedTargets.swampClub.hosts.includes(target.host);
}
function parseUrl(
  rawUrl: string,
  allowedGitlabHosts: string[],
): z.infer<typeof TargetSchema> {
  const url = new URL(rawUrl);
  url.hash = "";
  url.search = "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    (url.hostname === "github.com") && parts.length === 4 &&
    ["issues", "pull"].includes(parts[2]) && /^\d+$/.test(parts[3])
  ) {
    return {
      provider: "github",
      kind: parts[2] === "issues" ? "issue" : "pull_request",
      canonicalUrl: url.toString(),
      host: url.hostname,
      repository: `${parts[0]}/${parts[1]}`,
      iid: Number(parts[3]),
    };
  }
  if (parts[0] === "lab" && parts.length === 2 && /^\d+$/.test(parts[1])) {
    return {
      provider: "swamp_club",
      kind: "lab_issue",
      canonicalUrl: url.toString(),
      host: url.hostname,
      iid: Number(parts[1]),
    };
  }
  const marker = parts.lastIndexOf("-");
  if (
    marker > 0 &&
    (parts[marker + 1] === "issues" ||
      parts[marker + 1] === "merge_requests") &&
    /^\d+$/.test(parts[marker + 2] ?? "")
  ) {
    return {
      provider: "gitlab",
      kind: parts[marker + 1] === "issues" ? "issue" : "merge_request",
      canonicalUrl: url.toString(),
      host: url.hostname,
      project: parts.slice(0, marker).join("/"),
      iid: Number(parts[marker + 2]),
    };
  }
  const [kindSegment, iidSegment] = parts.slice(-2);
  if (
    allowedGitlabHosts.includes(url.hostname) &&
    parts.length >= 3 &&
    (kindSegment === "issues" || kindSegment === "merge_requests") &&
    /^\d+$/.test(iidSegment ?? "")
  ) {
    return {
      provider: "gitlab",
      kind: kindSegment === "issues" ? "issue" : "merge_request",
      canonicalUrl: url.toString(),
      host: url.hostname,
      project: parts.slice(0, -2).join("/"),
      iid: Number(iidSegment),
    };
  }
  throw new Error(`Unsupported triage URL: ${rawUrl}`);
}
function hasDependencyCycle(
  actions: Array<{ id: string; dependsOn: string[] }>,
): boolean {
  const byId = new Map(actions.map((action) => [action.id, action]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return actions.some((action) => visit(action.id));
}
function actionProvider(action: Action): Provider {
  if (action.type.startsWith("github.")) return "github";
  if (action.type.startsWith("gitlab.")) return "gitlab";
  return "swamp_club";
}
function requireMatchingIdempotencyKey(action: Action): void {
  const payload = action.payload as Record<string, unknown>;
  if (payload.idempotencyKey !== action.idempotencyKey) {
    throw new Error(
      `Action ${action.id} payload.idempotencyKey does not match its idempotencyKey`,
    );
  }
}
// Which physical provider instance executes an authorized payload (which
// GitHub App installation, which GitLab host, which Swamp Club deployment)
// is fixed by the calling workflow's own model selection
// (`modelIdOrName: ${{ inputs.github_model }}` etc.), not by this model —
// the same trust boundary applies to every authorize_*_action method. This
// function validates only within-instance addressing (repo/iid/issueNumber)
// against the assessed source; it has no visibility into, and cannot
// validate, which instance a workflow has wired up. github's repo strings
// happen to be globally unique, so a repo match incidentally also proves
// same-instance; swamp_club's issueNumber is a small per-deployment
// integer with no such guarantee, but there is still no host field on its
// payload to cross-check — that binding is out of this model's authority
// by design, not a gap.
function validatePayloadTarget(
  action: Action,
  source: z.infer<typeof ContextSchema>,
  config: z.infer<typeof GlobalArgsSchema>,
): void {
  const payload = action.payload as Record<string, unknown>;
  switch (action.type) {
    case "github.add_issue_comment":
    case "github.close_issue":
      requireMatchingIdempotencyKey(action);
      if (
        payload.repo !== source.target.repository ||
        payload.number !== source.target.iid
      ) {
        throw new Error(
          `Action ${action.id} payload does not target the assessed source`,
        );
      }
      return;
    case "github.retry_workflow_run":
      requireMatchingIdempotencyKey(action);
      // No workflow-run identifier is captured in the assessed source
      // context, so this can only be scoped to the assessed repository,
      // not to a specific run.
      if (payload.repo !== source.target.repository) {
        throw new Error(
          `Action ${action.id} payload targets a different repository than the assessed source`,
        );
      }
      return;
    case "gitlab.post_review":
    case "gitlab.post_inline_review":
      if (
        payload.project !== source.target.project ||
        payload.iid !== source.target.iid
      ) {
        throw new Error(
          `Action ${action.id} payload does not target the assessed source`,
        );
      }
      return;
    case "github.create_issue":
      requireMatchingIdempotencyKey(action);
      if (
        typeof payload.repo !== "string" ||
        !allowed(
          { provider: "github", host: "", repository: payload.repo },
          config,
        )
      ) {
        throw new Error(
          `Action ${action.id} payload target is not authorized by this triage instance`,
        );
      }
      return;
    case "swamp_club.post_ripple":
      requireMatchingIdempotencyKey(action);
      if (payload.issueNumber !== source.target.iid) {
        throw new Error(
          `Action ${action.id} payload does not target the assessed source`,
        );
      }
      return;
    default:
      throw new Error(`Unhandled action type: ${action.type}`);
  }
}
function actionMethod(action: Action): string {
  return action.type.slice(action.type.indexOf(".") + 1);
}
function authorizedActionName(bundleHash: string, actionId: string): string {
  return `authorized-${bundleHash}-${actionId}`;
}
async function authorizeAction(
  provider: Provider,
  bundleHash: string,
  actionId: string,
  context: Context,
) {
  const bundle = await requireResource(
    context,
    bundleHash,
    BundleSchema,
    "action bundle",
  );
  const expectedBundleHash = await hash({
    schemaVersion: bundle.schemaVersion,
    id: bundle.id,
    sourceRevision: bundle.sourceRevision,
    assessmentHash: bundle.assessmentHash,
    voiceProfile: bundle.voiceProfile,
    actions: bundle.actions,
  });
  if (bundle.bundleHash !== bundleHash || expectedBundleHash !== bundleHash) {
    throw new Error("Persisted action bundle hash does not match its contents");
  }
  const assessment = await requireResource(
    context,
    bundle.assessmentHash,
    AssessmentSchema,
    "assessment",
  );
  if (await hash(assessment) !== bundle.assessmentHash) {
    throw new Error("Persisted assessment hash does not match its contents");
  }
  const source = await requireResource(
    context,
    assessment.contextHash,
    ContextSchema,
    "source context",
  );
  if (
    source.sourceRevision !== assessment.contextHash ||
    source.sourceRevision !== bundle.sourceRevision
  ) {
    throw new Error(
      "Assessment or bundle is stale for the persisted source context",
    );
  }
  const binding = await requireResource(
    context,
    `approval-${bundleHash}`,
    ApprovalBindingSchema,
    "Sean approval binding",
  );
  if (
    binding.bundleHash !== bundleHash ||
    binding.assessmentHash !== bundle.assessmentHash ||
    binding.sourceRevision !== bundle.sourceRevision || binding.actor !== "Sean"
  ) {
    throw new Error(
      "Approval binding does not match the persisted action bundle",
    );
  }
  const action = bundle.actions.find((candidate) => candidate.id === actionId);
  if (!action) {
    throw new Error(`Action ${actionId} is not in the approved bundle`);
  }
  if (!binding.approvedActionIds.includes(actionId)) {
    throw new Error(`Action ${actionId} is not explicitly approved by Sean`);
  }
  if (
    action.dependsOn.some((dependency) =>
      !binding.approvedActionIds.includes(dependency)
    )
  ) {
    throw new Error("An action dependency is not included in Sean's approval");
  }
  if (actionProvider(action) !== provider) {
    throw new Error(`Action ${actionId} is not a ${provider} action`);
  }
  validatePayloadTarget(action, source, context.globalArgs);
  const authorized = {
    bundleHash,
    actionId,
    provider,
    methodName: actionMethod(action),
    payload: action.payload,
    verify: action.verify,
    authorizedAt: new Date().toISOString(),
  };
  const handle = await context.writeResource(
    "authorizedAction",
    authorizedActionName(bundleHash, actionId),
    authorized,
  );
  return { dataHandles: [handle] };
}

/** Deterministic cross-provider triage policy model. */
export const model = {
  type: "@webframp/triage",
  version: "2026.09.08.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [{
    toVersion: "2026.09.08.1",
    description: "Initial triage policy model",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  resources: {
    target: {
      description: "Canonical triage target",
      schema: TargetSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    context: {
      description: "Sanitized provider-neutral source snapshot",
      schema: ContextSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    assessment: {
      description:
        "Validated triage assessment, addressable by its content hash",
      schema: AssessmentSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    actionBundle: {
      description:
        "Hash-bound proposed external actions, addressable by bundle hash",
      schema: BundleSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    approvalBinding: {
      description: "Explicit Sean approval bound to an immutable action bundle",
      schema: ApprovalBindingSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    authorizedAction: {
      description:
        "One provider action released from a persisted Sean-approved bundle",
      schema: AuthorizedActionSchema,
      lifetime: "30m" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    parse_target: {
      description: "Parse, canonicalize, and authorize a supported triage URL.",
      arguments: z.object({ url: z.url() }).strict(),
      execute: async ({ url }: { url: string }, context: Context) => {
        const target = parseUrl(
          url,
          context.globalArgs.allowedTargets.gitlab.hosts,
        );
        if (!allowed(target, context.globalArgs)) {
          throw new Error(
            `Target is not authorized by this triage instance: ${target.canonicalUrl}`,
          );
        }
        const handle = await context.writeResource(
          "target",
          await hash(target),
          target,
        );
        return { dataHandles: [handle] };
      },
    },
    record_context: {
      description:
        "Validate and persist a bounded, sanitized provider context.",
      arguments: z.object({ context: ContextSchema }).strict(),
      execute: async (
        { context: payload }: { context: z.infer<typeof ContextSchema> },
        context: Context,
      ) => {
        if (!allowed(payload.target, context.globalArgs)) {
          throw new Error("Context target is not authorized");
        }
        const expected = await hash({
          ...payload,
          sourceRevision: undefined,
          fetchedAt: undefined,
        });
        if (payload.sourceRevision !== expected) {
          throw new Error(
            "Context sourceRevision does not match canonical content hash",
          );
        }
        const handle = await context.writeResource(
          "context",
          payload.sourceRevision,
          payload,
        );
        return { dataHandles: [handle] };
      },
    },
    record_assessment: {
      description:
        "Validate and persist an assessment bound to the saved source context.",
      arguments: z.object({ assessment: AssessmentSchema }).strict(),
      execute: async (
        { assessment }: { assessment: z.infer<typeof AssessmentSchema> },
        context: Context,
      ) => {
        const source = await requireResource(
          context,
          assessment.contextHash,
          ContextSchema,
          "source context",
        );
        if (source.sourceRevision !== assessment.contextHash) {
          throw new Error(
            "Assessment contextHash does not reference the saved source revision",
          );
        }
        const sourceIds = new Set([
          source.body.contextId,
          ...source.conversation.map((entry) => entry.contextId),
        ]);
        if (
          assessment.evidence.some((evidence) =>
            !sourceIds.has(evidence.contextId)
          )
        ) {
          throw new Error(
            "Assessment cites context not present in the saved snapshot",
          );
        }
        if (
          assessment.securitySignal !== "none" &&
          (assessment.disposition === "needs_author_feedback" ||
            assessment.disposition === "reroute_to_github" ||
            assessment.disposition === "review")
        ) {
          throw new Error(
            "Security-signaled assessment cannot propose publicly-visible content",
          );
        }
        const assessmentHash = await hash(assessment);
        const handle = await context.writeResource(
          "assessment",
          assessmentHash,
          assessment,
        );
        return { dataHandles: [handle] };
      },
    },
    build_action_bundle: {
      description:
        "Hash and persist an immutable bundle only for a saved matching assessment.",
      arguments: z.object({ bundle: BundleSchema.omit({ bundleHash: true }) })
        .strict(),
      execute: async (
        { bundle }: {
          bundle: Omit<z.infer<typeof BundleSchema>, "bundleHash">;
        },
        context: Context,
      ) => {
        const assessment = await requireResource(
          context,
          bundle.assessmentHash,
          AssessmentSchema,
          "assessment",
        );
        if (await hash(assessment) !== bundle.assessmentHash) {
          throw new Error(
            "Bundle assessmentHash does not match a saved assessment",
          );
        }
        if (assessment.contextHash !== bundle.sourceRevision) {
          throw new Error(
            "Bundle sourceRevision does not match its saved assessment",
          );
        }
        const ids = new Set(bundle.actions.map((action) => action.id));
        if (
          ids.size !== bundle.actions.length ||
          bundle.actions.some((action) =>
            action.dependsOn.some((dependency) => !ids.has(dependency))
          ) ||
          hasDependencyCycle(bundle.actions)
        ) {
          throw new Error(
            "Action dependencies must reference distinct actions in the bundle without cycles",
          );
        }
        const idempotencyKeys = new Set(
          bundle.actions.map((action) => action.idempotencyKey),
        );
        if (idempotencyKeys.size !== bundle.actions.length) {
          throw new Error(
            "Action idempotencyKeys must be unique within a bundle",
          );
        }
        const bundleHash = await hash(bundle);
        const handle = await context.writeResource("actionBundle", bundleHash, {
          ...bundle,
          bundleHash,
        });
        return { dataHandles: [handle] };
      },
    },
    bind_approval: {
      description:
        "Persist Sean's explicit approval only for actions in a matching saved bundle.",
      arguments: z.object({
        binding: ApprovalBindingSchema.omit({ approvedAt: true }),
      }).strict(),
      execute: async (
        { binding }: {
          binding: Omit<z.infer<typeof ApprovalBindingSchema>, "approvedAt">;
        },
        context: Context,
      ) => {
        const bundle = await requireResource(
          context,
          binding.bundleHash,
          BundleSchema,
          "action bundle",
        );
        if (
          bundle.assessmentHash !== binding.assessmentHash ||
          bundle.sourceRevision !== binding.sourceRevision
        ) {
          throw new Error(
            "Approval binding does not match the saved action bundle",
          );
        }
        const validActionIds = new Set(
          bundle.actions.map((action) => action.id),
        );
        if (
          new Set(binding.approvedActionIds).size !==
            binding.approvedActionIds.length ||
          binding.approvedActionIds.some((id) => !validActionIds.has(id))
        ) {
          throw new Error(
            "Approval contains an action that is not in the saved bundle",
          );
        }
        const handle = await context.writeResource(
          "approvalBinding",
          `approval-${binding.bundleHash}`,
          { ...binding, approvedAt: new Date().toISOString() },
        );
        return { dataHandles: [handle] };
      },
    },
    authorize_github_action: {
      description:
        "Release one persisted Sean-approved GitHub action and no caller-supplied payload.",
      arguments: z.object({ bundleHash: text, actionId: text }).strict(),
      execute: async (
        args: { bundleHash: string; actionId: string },
        context: Context,
      ) =>
        await authorizeAction(
          "github",
          args.bundleHash,
          args.actionId,
          context,
        ),
    },
    authorize_gitlab_review_action: {
      description:
        "Release one persisted Sean-approved GitLab review action and no caller-supplied payload.",
      arguments: z.object({ bundleHash: text, actionId: text }).strict(),
      execute: async (
        args: { bundleHash: string; actionId: string },
        context: Context,
      ) =>
        await authorizeAction(
          "gitlab",
          args.bundleHash,
          args.actionId,
          context,
        ),
    },
    authorize_swamp_club_action: {
      description:
        "Release one persisted Sean-approved Swamp Club ripple and no caller-supplied payload.",
      arguments: z.object({ bundleHash: text, actionId: text }).strict(),
      execute: async (
        args: { bundleHash: string; actionId: string },
        context: Context,
      ) =>
        await authorizeAction(
          "swamp_club",
          args.bundleHash,
          args.actionId,
          context,
        ),
    },
  },
};
