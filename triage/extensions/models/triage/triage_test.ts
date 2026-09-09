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
      target: { repo: "webframp/swamp-extensions", number: 1 },
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
