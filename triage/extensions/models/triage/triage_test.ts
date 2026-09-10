import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { model } from "./triage.ts";

const globalArgs = {
  allowedTargets: {
    github: { repositoryPatterns: ["webframp/*"] },
    gitlab: { hosts: ["git.bethelservice.org"] },
    swampClub: { hosts: ["swamp-club.com"] },
  },
  verificationProfiles: [{
    provider: "github" as const,
    repository: "webframp/swamp-extensions",
    required: ["deno check", "deno test", "deno fmt --check"],
  }],
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stable(value)),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
function testContext(resources = new Map<string, Record<string, unknown>>()) {
  return {
    globalArgs,
    readResource: (name: string) =>
      Promise.resolve(resources.get(name) ?? null),
    writeResource: (_spec: string, name: string, data: unknown) => {
      resources.set(name, data as Record<string, unknown>);
      return Promise.resolve({ name });
    },
    logger: { info: () => undefined },
  };
}
async function persistedAction(
  resources: Map<string, Record<string, unknown>>,
) {
  const sourceRevision = "source-r1";
  resources.set(sourceRevision, {
    schemaVersion: 1,
    target: {
      provider: "github",
      kind: "issue",
      canonicalUrl: "https://github.com/webframp/swamp-extensions/issues/1",
      host: "github.com",
      repository: "webframp/swamp-extensions",
      iid: 1,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision,
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open",
    labels: [],
    conversation: [],
    truncation: [],
  });
  const assessment = {
    schemaVersion: 1 as const,
    contextHash: sourceRevision,
    targetKind: "issue" as const,
    classification: "bug" as const,
    priority: "low" as const,
    disposition: "close" as const,
    confidence: "high" as const,
    summary: "Safe to close",
    evidence: [{ contextId: "body", claim: "No reproduction details" }],
    questions: [],
    recommendedNextAction: "Close the duplicate",
    securitySignal: "none" as const,
  };
  const assessmentHash = await hash(assessment);
  resources.set(assessmentHash, assessment);
  const unsealedBundle = {
    schemaVersion: 1 as const,
    id: "bundle-1",
    sourceRevision,
    assessmentHash,
    voiceProfile: { dataVersion: "1", contentHash: "voice-1" },
    actions: [{
      id: "close-issue",
      type: "github.close_issue" as const,
      target: { repository: "webframp/swamp-extensions", iid: 1 },
      payload: {
        repo: "webframp/swamp-extensions",
        number: 1,
        idempotencyKey: "close-issue-1",
      },
      dependsOn: [],
      idempotencyKey: "close-issue-1",
      verify: { state: "closed" },
    }],
  };
  const bundleHash = await hash(unsealedBundle);
  resources.set(bundleHash, { ...unsealedBundle, bundleHash });
  return { bundleHash };
}

Deno.test("parse_target enforces configured allowlists", async () => {
  const context = testContext();
  await assertRejects(
    () =>
      model.methods.parse_target.execute({
        url: "https://github.com/other/repo/issues/1",
      }, context as never),
    Error,
    "not authorized",
  );
});
Deno.test("parse_target accepts a GitLab issue URL without a /-/ separator", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  await model.methods.parse_target.execute({
    url: "https://git.bethelservice.org/group/project/issues/123",
  }, context as never);
  const written = [...resources.values()].find((r) => r.provider === "gitlab");
  assertEquals(written?.kind, "issue");
  assertEquals(written?.project, "group/project");
  assertEquals(written?.iid, 123);
});

Deno.test("parse_target accepts a GitLab merge request URL without a /-/ separator", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  await model.methods.parse_target.execute({
    url: "https://git.bethelservice.org/group/project/merge_requests/45",
  }, context as never);
  const written = [...resources.values()].find((r) => r.provider === "gitlab");
  assertEquals(written?.kind, "merge_request");
  assertEquals(written?.project, "group/project");
  assertEquals(written?.iid, 45);
});

Deno.test("parse_target rejects a bare issues/N URL on a host not in the configured GitLab allowlist", async () => {
  const context = testContext();
  await assertRejects(
    () =>
      model.methods.parse_target.execute({
        url: "https://ghe.example.com/group/project/issues/123",
      }, context as never),
    Error,
    "Unsupported triage URL",
  );
});

Deno.test("build_action_bundle rejects a two-node dependency cycle", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const sourceRevision = "source-cycle";
  resources.set(sourceRevision, {
    schemaVersion: 1,
    target: {
      provider: "github",
      kind: "issue",
      canonicalUrl: "https://github.com/webframp/swamp-extensions/issues/9",
      host: "github.com",
      repository: "webframp/swamp-extensions",
      iid: 9,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision,
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open",
    labels: [],
    conversation: [],
    truncation: [],
  });
  const assessment = {
    schemaVersion: 1 as const,
    contextHash: sourceRevision,
    targetKind: "issue" as const,
    classification: "bug" as const,
    priority: "low" as const,
    disposition: "close" as const,
    confidence: "high" as const,
    summary: "Safe to close",
    evidence: [{ contextId: "body", claim: "No reproduction details" }],
    questions: [],
    recommendedNextAction: "Close the duplicate",
    securitySignal: "none" as const,
  };
  const assessmentHash = await hash(assessment);
  resources.set(assessmentHash, assessment);
  const bundle = {
    schemaVersion: 1 as const,
    id: "bundle-cycle",
    sourceRevision,
    assessmentHash,
    voiceProfile: { dataVersion: "1", contentHash: "voice-1" },
    actions: [
      {
        id: "action-a",
        type: "github.close_issue" as const,
        target: { repository: "webframp/swamp-extensions", iid: 9 },
        payload: {
          repo: "webframp/swamp-extensions",
          number: 9,
          idempotencyKey: "a",
        },
        dependsOn: ["action-b"],
        idempotencyKey: "a",
        verify: {},
      },
      {
        id: "action-b",
        type: "github.close_issue" as const,
        target: { repository: "webframp/swamp-extensions", iid: 9 },
        payload: {
          repo: "webframp/swamp-extensions",
          number: 9,
          idempotencyKey: "b",
        },
        dependsOn: ["action-a"],
        idempotencyKey: "b",
        verify: {},
      },
    ],
  };
  await assertRejects(
    () =>
      model.methods.build_action_bundle.execute(
        { bundle },
        context as never,
      ),
    Error,
    "without cycles",
  );
});
Deno.test("approval requires Sean", () => {
  assertEquals(
    model.methods.bind_approval.arguments.safeParse({
      binding: {
        bundleHash: "b",
        assessmentHash: "a",
        sourceRevision: "s",
        approvedActionIds: ["x"],
        actor: "other",
      },
    }).success,
    false,
  );
});
Deno.test("authorization rejects a bundle without a persisted Sean binding", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const { bundleHash } = await persistedAction(resources);
  await assertRejects(
    () =>
      model.methods.authorize_github_action.execute({
        bundleHash,
        actionId: "close-issue",
      }, context as never),
    Error,
    "Sean approval binding",
  );
});
Deno.test("authorization releases only the persisted approved action payload", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const { bundleHash } = await persistedAction(resources);
  const unsealedBundle = resources.get(bundleHash)!;
  const binding = {
    bundleHash,
    assessmentHash: unsealedBundle.assessmentHash,
    sourceRevision: unsealedBundle.sourceRevision,
    approvedActionIds: ["close-issue"],
    actor: "Sean",
    approvedAt: "2026-09-08T00:01:00.000Z",
  };
  resources.set(bundleHash, unsealedBundle);
  await model.methods.bind_approval.execute({
    binding: {
      bundleHash,
      assessmentHash: String(binding.assessmentHash),
      sourceRevision: String(binding.sourceRevision),
      approvedActionIds: binding.approvedActionIds,
      actor: "Sean",
    },
  }, context as never);
  await model.methods.authorize_github_action.execute({
    bundleHash,
    actionId: "close-issue",
  }, context as never);
  const authorized = resources.get(`authorized-${bundleHash}-close-issue`);
  assertEquals(authorized?.methodName, "close_issue");
  assertEquals(authorized?.payload, {
    repo: "webframp/swamp-extensions",
    number: 1,
    idempotencyKey: "close-issue-1",
  });
});
Deno.test("authorization rejects an action whose target does not match the assessed source", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const sourceRevision = "source-mismatch";
  resources.set(sourceRevision, {
    schemaVersion: 1,
    target: {
      provider: "github",
      kind: "issue",
      canonicalUrl: "https://github.com/webframp/swamp-extensions/issues/1",
      host: "github.com",
      repository: "webframp/swamp-extensions",
      iid: 1,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision,
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open",
    labels: [],
    conversation: [],
    truncation: [],
  });
  const assessment = {
    schemaVersion: 1 as const,
    contextHash: sourceRevision,
    targetKind: "issue" as const,
    classification: "bug" as const,
    priority: "low" as const,
    disposition: "close" as const,
    confidence: "high" as const,
    summary: "Safe to close",
    evidence: [{ contextId: "body", claim: "No reproduction details" }],
    questions: [],
    recommendedNextAction: "Close the duplicate",
    securitySignal: "none" as const,
  };
  const assessmentHash = await hash(assessment);
  resources.set(assessmentHash, assessment);
  const unsealedBundle = {
    schemaVersion: 1 as const,
    id: "bundle-mismatch",
    sourceRevision,
    assessmentHash,
    voiceProfile: { dataVersion: "1", contentHash: "voice-1" },
    actions: [{
      id: "close-issue",
      type: "github.close_issue" as const,
      target: { repository: "webframp/some-other-repo", iid: 1 },
      payload: {
        repo: "webframp/some-other-repo",
        number: 1,
        idempotencyKey: "close-issue-1",
      },
      dependsOn: [],
      idempotencyKey: "close-issue-1",
      verify: { state: "closed" },
    }],
  };
  const bundleHash = await hash(unsealedBundle);
  resources.set(bundleHash, { ...unsealedBundle, bundleHash });
  await model.methods.bind_approval.execute({
    binding: {
      bundleHash,
      assessmentHash,
      sourceRevision,
      approvedActionIds: ["close-issue"],
      actor: "Sean",
    },
  }, context as never);
  await assertRejects(
    () =>
      model.methods.authorize_github_action.execute({
        bundleHash,
        actionId: "close-issue",
      }, context as never),
    Error,
    "target does not match the assessed source target",
  );
});
Deno.test("authorization rejects a new-target action outside the configured allowlist", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const sourceRevision = "source-reroute";
  resources.set(sourceRevision, {
    schemaVersion: 1,
    target: {
      provider: "gitlab",
      kind: "merge_request",
      canonicalUrl:
        "https://git.bethelservice.org/group/project/-/merge_requests/1",
      host: "git.bethelservice.org",
      project: "group/project",
      iid: 1,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision,
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open",
    labels: [],
    conversation: [],
    truncation: [],
  });
  const assessment = {
    schemaVersion: 1 as const,
    contextHash: sourceRevision,
    targetKind: "change" as const,
    classification: "security" as const,
    priority: "high" as const,
    disposition: "review" as const,
    confidence: "high" as const,
    summary: "Escalate",
    evidence: [{ contextId: "body", claim: "Needs a public tracking issue" }],
    questions: [],
    recommendedNextAction: "Open a tracking issue",
    securitySignal: "none" as const,
  };
  const assessmentHash = await hash(assessment);
  resources.set(assessmentHash, assessment);
  const unsealedBundle = {
    schemaVersion: 1 as const,
    id: "bundle-reroute",
    sourceRevision,
    assessmentHash,
    voiceProfile: { dataVersion: "1", contentHash: "voice-1" },
    actions: [{
      id: "create-issue",
      type: "github.create_issue" as const,
      target: { repository: "not-in-the-allowlist/repo" },
      payload: {
        repo: "not-in-the-allowlist/repo",
        title: "Example",
        body: "Example",
        idempotencyKey: "create-1",
      },
      dependsOn: [],
      idempotencyKey: "create-1",
      verify: {},
    }],
  };
  const bundleHash = await hash(unsealedBundle);
  resources.set(bundleHash, { ...unsealedBundle, bundleHash });
  await model.methods.bind_approval.execute({
    binding: {
      bundleHash,
      assessmentHash,
      sourceRevision,
      approvedActionIds: ["create-issue"],
      actor: "Sean",
    },
  }, context as never);
  await assertRejects(
    () =>
      model.methods.authorize_github_action.execute({
        bundleHash,
        actionId: "create-issue",
      }, context as never),
    Error,
    "target is not authorized",
  );
});
Deno.test("record_assessment rejects a security-signaled reroute_to_github disposition", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const sourceRevision = "source-security";
  resources.set(sourceRevision, {
    schemaVersion: 1,
    target: {
      provider: "gitlab",
      kind: "issue",
      canonicalUrl: "https://git.bethelservice.org/group/project/-/issues/1",
      host: "git.bethelservice.org",
      project: "group/project",
      iid: 1,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision,
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open",
    labels: [],
    conversation: [],
    truncation: [],
  });
  await assertRejects(
    () =>
      model.methods.record_assessment.execute({
        assessment: {
          schemaVersion: 1,
          contextHash: sourceRevision,
          targetKind: "issue",
          classification: "security",
          priority: "high",
          disposition: "reroute_to_github",
          confidence: "high",
          summary: "Possible vulnerability",
          evidence: [{ contextId: "body", claim: "Looks exploitable" }],
          questions: [],
          recommendedNextAction: "Open a tracking issue",
          securitySignal: "confirmed",
        },
      }, context as never),
    Error,
    "publicly-visible content",
  );
});
Deno.test("record_context accepts a context whose sourceRevision matches its canonical content hash", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const base = {
    schemaVersion: 1 as const,
    target: {
      provider: "github" as const,
      kind: "issue" as const,
      canonicalUrl: "https://github.com/webframp/swamp-extensions/issues/2",
      host: "github.com",
      repository: "webframp/swamp-extensions",
      iid: 2,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open" as const,
    labels: [],
    conversation: [],
    truncation: [],
  };
  const sourceRevision = await hash({
    ...base,
    sourceRevision: undefined,
    fetchedAt: undefined,
  });
  const handle = await model.methods.record_context.execute(
    { context: { ...base, sourceRevision } },
    context as never,
  );
  assertEquals(handle.dataHandles[0].name, sourceRevision);
  assertEquals(resources.get(sourceRevision)?.title, "Example");
});
Deno.test("record_context rejects a sourceRevision that does not match the canonical content hash", async () => {
  const resources = new Map<string, Record<string, unknown>>();
  const context = testContext(resources);
  const payload = {
    schemaVersion: 1 as const,
    target: {
      provider: "github" as const,
      kind: "issue" as const,
      canonicalUrl: "https://github.com/webframp/swamp-extensions/issues/3",
      host: "github.com",
      repository: "webframp/swamp-extensions",
      iid: 3,
    },
    fetchedAt: "2026-09-08T00:00:00.000Z",
    sourceRevision: "not-the-real-hash",
    title: "Example",
    body: { contextId: "body", text: "Example", truncated: false },
    state: "open" as const,
    labels: [],
    conversation: [],
    truncation: [],
  };
  await assertRejects(
    () =>
      model.methods.record_context.execute(
        { context: payload },
        context as never,
      ),
    Error,
    "does not match canonical content hash",
  );
});
