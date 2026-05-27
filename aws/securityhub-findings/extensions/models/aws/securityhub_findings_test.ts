/**
 * Unit tests for @webframp/aws/securityhub-findings model.
 *
 * @module
 */
import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { SecurityHubClient } from "npm:@aws-sdk/client-securityhub@3.1010.0";
import { model } from "./securityhub_findings.ts";

// =============================================================================
// Mock helper
// =============================================================================

function mockSecurityHub(
  // deno-lint-ignore no-explicit-any
  handler: (command: any) => unknown,
): () => void {
  const original = SecurityHubClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  SecurityHubClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    SecurityHubClient.prototype.send = original;
  };
}

function createMockContext() {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    globalArgs: { region: "us-east-1" },
    logger: {
      info: (msg: string, _props?: Record<string, unknown>) => {
        logs.push(msg);
      },
    },
    writeResource: (spec: string, name: string, data: unknown) => {
      written.push({ spec, name, data });
      return Promise.resolve({ spec, name });
    },
    written,
    logs,
  };
}

// =============================================================================
// Test data
// =============================================================================

const finding1 = {
  Id: "arn:aws:securityhub:us-east-1:123456789012:finding/abc",
  ProductArn: "arn:aws:securityhub:us-east-1::product/aws/guardduty",
  Types: ["TTPs/Impact/IAMUser-AnomalousBehavior"],
  Severity: { Label: "HIGH", Product: 8.0 },
  Title: "CDK deploy role anomalous impact",
  Description: "CDK deploy role invoked impact APIs",
  AwsAccountId: "123456789012",
  Region: "us-east-1",
  ProductFields: { "aws/securityhub/ProductName": "GuardDuty" },
  Resources: [{ Type: "AwsIamAccessKey", Id: "AKIAIOSFODNN7EXAMPLE" }],
  Workflow: { Status: "NEW" },
  RecordState: "ACTIVE",
  CreatedAt: "2026-05-26T09:30:00Z",
  UpdatedAt: "2026-05-26T12:00:00Z",
};

const finding2 = {
  Id: "arn:aws:securityhub:us-east-2:809228258731:finding/def",
  ProductArn: "arn:aws:securityhub:us-east-2::product/aws/guardduty",
  Types: [
    "TTPs/Persistence/Persistence:Kubernetes-ContainerWithSensitiveMount",
  ],
  Severity: { Label: "MEDIUM", Product: 5.0 },
  Title: "Container with sensitive mount",
  Description: "Container launched with sensitive host path",
  AwsAccountId: "809228258731",
  Region: "us-east-2",
  ProductFields: { "aws/securityhub/ProductName": "GuardDuty" },
  Resources: [{ Type: "Container", Id: "container-xyz" }],
  Workflow: { Status: "NEW" },
  RecordState: "ACTIVE",
  CreatedAt: "2026-05-26T08:37:00Z",
  UpdatedAt: "2026-05-26T09:00:00Z",
};

// =============================================================================
// Model structure tests
// =============================================================================

Deno.test("model exports correct type", () => {
  assertEquals(model.type, "@webframp/aws/securityhub-findings");
});

Deno.test("model version matches CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has all expected methods", () => {
  const names = Object.keys(model.methods);
  for (
    const m of [
      "list_findings",
      "get_finding_details",
      "get_severity_summary",
      "archive_findings",
      "resolve_findings",
      "reopen_findings",
      "list_findings_by_type",
      "diff_findings",
      "resolve_accounts",
      "list_all_findings",
    ]
  ) {
    assertEquals(names.includes(m), true, `missing method: ${m}`);
  }
});

Deno.test("all resource specs have lifetime and garbageCollection", () => {
  for (const [name, spec] of Object.entries(model.resources)) {
    assertEquals(typeof spec.lifetime, "string", `${name} missing lifetime`);
    assertEquals(
      typeof spec.garbageCollection,
      "number",
      `${name} missing garbageCollection`,
    );
  }
});

// =============================================================================
// list_findings — business logic
// =============================================================================

Deno.test({
  name:
    "list_findings maps findings correctly and sets truncated from NextToken",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1, finding2],
      NextToken: "page2token",
    }));
    try {
      const ctx = createMockContext();
      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 2, workflowStatus: "NEW" },
        ctx,
      );
      assertEquals(ctx.written.length, 1);
      const data = ctx.written[0].data as {
        count: number;
        truncated: boolean;
        findings: Array<
          { severity: string; accountId: string; productArn: string }
        >;
      };
      assertEquals(data.count, 2);
      assertEquals(data.truncated, true); // NextToken present
      assertEquals(data.findings[0].severity, "HIGH");
      assertEquals(data.findings[0].accountId, "123456789012");
      assertEquals(
        data.findings[0].productArn,
        "arn:aws:securityhub:us-east-1::product/aws/guardduty",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_findings sets truncated=false when no NextToken",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1],
      // No NextToken
    }));
    try {
      const ctx = createMockContext();
      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 100, workflowStatus: "NEW" },
        ctx,
      );
      const data = ctx.written[0].data as { truncated: boolean };
      assertEquals(data.truncated, false);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_findings produces deterministic instance name from raw args",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({ Findings: [] }));
    try {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 10, workflowStatus: "NEW" },
        ctx1,
      );
      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 10, workflowStatus: "NEW" },
        ctx2,
      );
      // Same args → same instance name
      assertEquals(ctx1.written[0].name, ctx2.written[0].name);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_findings produces different instance names for different filters",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({ Findings: [] }));
    try {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await model.methods.list_findings.execute(
        {
          productName: "GuardDuty_HIGH",
          startTime: "24h",
          limit: 10,
          workflowStatus: "NEW",
        },
        ctx1,
      );
      await model.methods.list_findings.execute(
        {
          productName: "GuardDuty",
          severityLabel: "HIGH",
          startTime: "24h",
          limit: 10,
          workflowStatus: "NEW",
        },
        ctx2,
      );
      // Different filters → different instance names (no collision)
      assertEquals(ctx1.written[0].name !== ctx2.written[0].name, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_finding_details — business logic
// =============================================================================

Deno.test({
  name: "get_finding_details reports notFound ARNs",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1], // only returns 1 of 2 requested
    }));
    try {
      const ctx = createMockContext();
      await model.methods.get_finding_details.execute(
        {
          findingArns: [
            finding1.Id,
            "arn:aws:securityhub:us-east-1:999:finding/missing",
          ],
        },
        ctx,
      );
      const data = ctx.written[0].data as {
        count: number;
        notFound: string[];
      };
      assertEquals(data.count, 1);
      assertEquals(data.notFound.length, 1);
      assertEquals(
        data.notFound[0],
        "arn:aws:securityhub:us-east-1:999:finding/missing",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "get_finding_details produces different instance names for different ARN sets",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({ Findings: [] }));
    try {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await model.methods.get_finding_details.execute(
        { findingArns: [finding1.Id] },
        ctx1,
      );
      await model.methods.get_finding_details.execute(
        { findingArns: [finding2.Id] },
        ctx2,
      );
      assertEquals(ctx1.written[0].name !== ctx2.written[0].name, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_severity_summary — business logic
// =============================================================================

Deno.test({
  name: "get_severity_summary counts by severity and account correctly",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1, finding2],
    }));
    try {
      const ctx = createMockContext();
      await model.methods.get_severity_summary.execute(
        { startTime: "24h", workflowStatus: "NEW" },
        ctx,
      );
      const data = ctx.written[0].data as {
        high: number;
        medium: number;
        total: number;
        truncated: boolean;
        accountBreakdown: Array<{
          accountId: string;
          high: number;
          medium: number;
          informational: number;
        }>;
      };
      assertEquals(data.high, 1);
      assertEquals(data.medium, 1);
      assertEquals(data.total, 2);
      assertEquals(data.truncated, false);
      const acct1 = data.accountBreakdown.find(
        (a) => a.accountId === "123456789012",
      );
      assertEquals(acct1?.high, 1);
      assertEquals(typeof acct1?.informational, "number"); // field present
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "get_severity_summary uses raw startTime in instance name (deterministic)",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({ Findings: [] }));
    try {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await model.methods.get_severity_summary.execute(
        { startTime: "24h", workflowStatus: "NEW" },
        ctx1,
      );
      // Small delay to ensure Date.now() would differ if timestamp were used
      await new Promise((r) => setTimeout(r, 10));
      await model.methods.get_severity_summary.execute(
        { startTime: "24h", workflowStatus: "NEW" },
        ctx2,
      );
      // Same raw args → same instance name (not timestamp-based)
      assertEquals(ctx1.written[0].name, ctx2.written[0].name);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// archive/resolve/reopen — business logic
// =============================================================================

Deno.test({
  name: "archive_findings uses real ProductArn from GetFindings",
  sanitizeResources: false,
  fn: async () => {
    let batchUpdateCalled = false;
    let capturedIdentifiers: Array<{ Id: string; ProductArn: string }> = [];

    const restore = mockSecurityHub((command) => {
      if (command.constructor.name === "GetFindingsCommand") {
        return { Findings: [finding1] };
      }
      if (command.constructor.name === "BatchUpdateFindingsCommand") {
        batchUpdateCalled = true;
        capturedIdentifiers = command.input.FindingIdentifiers;
        return {
          ProcessedFindings: [{ Id: finding1.Id }],
          UnprocessedFindings: [],
        };
      }
      return {};
    });
    try {
      const ctx = createMockContext();
      await model.methods.archive_findings.execute(
        { findingArns: [finding1.Id], note: "Known behavior" },
        ctx,
      );
      assertEquals(batchUpdateCalled, true);
      assertEquals(capturedIdentifiers[0].ProductArn, finding1.ProductArn);
      const data = ctx.written[0].data as {
        updated: number;
        failed: number;
        newStatus: string;
      };
      assertEquals(data.updated, 1);
      assertEquals(data.failed, 0);
      assertEquals(data.newStatus, "SUPPRESSED");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "archive_findings throws when no findings resolve",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({ Findings: [] }));
    try {
      const ctx = createMockContext();
      await assertRejects(
        () =>
          model.methods.archive_findings.execute(
            {
              findingArns: [
                "arn:aws:securityhub:us-east-1:123:finding/missing",
              ],
              note: "test",
            },
            ctx,
          ),
        Error,
        "finding ARNs could be resolved",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "archive and resolve produce different instance names",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub((command) => {
      if (command.constructor.name === "GetFindingsCommand") {
        return { Findings: [finding1] };
      }
      return {
        ProcessedFindings: [{ Id: finding1.Id }],
        UnprocessedFindings: [],
      };
    });
    try {
      const ctx1 = createMockContext();
      const ctx2 = createMockContext();
      await model.methods.archive_findings.execute(
        { findingArns: [finding1.Id], note: "test" },
        ctx1,
      );
      await model.methods.resolve_findings.execute(
        { findingArns: [finding1.Id], note: "test" },
        ctx2,
      );
      // Different status → different instance names
      assertEquals(ctx1.written[0].name !== ctx2.written[0].name, true);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// Schema validation tests
// =============================================================================

Deno.test("list_findings applies defaults", () => {
  const result = model.methods.list_findings.arguments.safeParse({});
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.startTime, "24h");
    assertEquals(result.data.limit, 100);
    assertEquals(result.data.workflowStatus, "NEW");
  }
});

Deno.test("list_findings rejects limit > 100", () => {
  assertEquals(
    model.methods.list_findings.arguments.safeParse({
      startTime: "24h",
      limit: 200,
      workflowStatus: "NEW",
    }).success,
    false,
  );
});

Deno.test("archive_findings rejects note > 512 chars", () => {
  assertEquals(
    model.methods.archive_findings.arguments.safeParse({
      findingArns: ["arn:aws:securityhub:us-east-1:123:finding/x"],
      note: "a".repeat(513),
    }).success,
    false,
  );
});

Deno.test("archive_findings rejects empty note", () => {
  assertEquals(
    model.methods.archive_findings.arguments.safeParse({
      findingArns: ["arn:aws:securityhub:us-east-1:123:finding/x"],
      note: "",
    }).success,
    false,
  );
});

Deno.test("get_finding_details rejects empty array", () => {
  assertEquals(
    model.methods.get_finding_details.arguments.safeParse({
      findingArns: [],
    }).success,
    false,
  );
});

// =============================================================================
// list_findings_by_type tests
// =============================================================================

Deno.test({
  name: "list_findings_by_type groups findings correctly",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1, finding2, finding1], // 2x finding1 type, 1x finding2 type
    }));
    try {
      const ctx = createMockContext();
      await model.methods.list_findings_by_type.execute(
        { startTime: "24h", limit: 100 },
        ctx,
      );
      const data = ctx.written[0].data as {
        groups: Array<{ type: string; count: number; accounts: string[] }>;
        totalTypes: number;
        totalFindings: number;
      };
      assertEquals(data.totalFindings, 3);
      assertEquals(data.totalTypes, 2);
      // Sorted by count desc — finding1 type has 2
      assertEquals(data.groups[0].count, 2);
      assertEquals(data.groups[1].count, 1);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// diff_findings tests
// =============================================================================

Deno.test({
  name: "diff_findings identifies new findings when no previous data",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1, finding2],
    }));
    try {
      const ctx = createMockContext();
      // readResource returns null (no previous run)
      (ctx as unknown as { readResource: () => Promise<null> }).readResource =
        () => Promise.resolve(null);
      await model.methods.diff_findings.execute(
        { startTime: "24h", limit: 100 },
        ctx,
      );
      // Should write diff_findings
      assertEquals(ctx.written.length, 1);
      const diffData = ctx.written[0].data as {
        newCount: number;
        resolvedCount: number;
      };
      assertEquals(diffData.newCount, 2); // all are new
      assertEquals(diffData.resolvedCount, 0);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "diff_findings identifies resolved findings",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1], // only finding1 remains
    }));
    try {
      const ctx = createMockContext();
      // Previous run had both findings (stored as currentSnapshot, not truncated)
      (ctx as unknown as { readResource: () => Promise<unknown> })
        .readResource = () =>
          Promise.resolve({
            currentSnapshot: [
              {
                arn: finding1.Id,
                id: "f1",
                type: "T",
                severity: "HIGH",
                severityScore: 8,
                title: "t",
                description: "",
                accountId: "123",
                region: "us-east-1",
                productName: "GD",
                productArn: "",
                resourceType: null,
                resourceId: null,
                workflowStatus: "NEW",
                recordState: "ACTIVE",
                createdAt: "",
                updatedAt: "",
              },
              {
                arn: finding2.Id,
                id: "f2",
                type: "T",
                severity: "MEDIUM",
                severityScore: 5,
                title: "t",
                description: "",
                accountId: "456",
                region: "us-east-2",
                productName: "GD",
                productArn: "",
                resourceType: null,
                resourceId: null,
                workflowStatus: "NEW",
                recordState: "ACTIVE",
                createdAt: "",
                updatedAt: "",
              },
            ],
            snapshotTruncated: false,
          });
      await model.methods.diff_findings.execute(
        { startTime: "24h", limit: 100 },
        ctx,
      );
      const diffData = ctx.written[0].data as {
        newCount: number;
        resolvedCount: number;
      };
      assertEquals(diffData.newCount, 0);
      assertEquals(diffData.resolvedCount, 1); // finding2 resolved
    } finally {
      restore();
    }
  },
});

Deno.test({
  name:
    "diff_findings suppresses both new and resolved when previous was truncated",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1], // only finding1 in current
    }));
    try {
      const ctx = createMockContext();
      // Previous run was truncated — stored snapshot is incomplete
      (ctx as unknown as { readResource: () => Promise<unknown> })
        .readResource = () =>
          Promise.resolve({
            currentSnapshot: [
              { arn: finding2.Id },
            ],
            truncated: true, // previous was truncated
          });
      await model.methods.diff_findings.execute(
        { startTime: "24h", limit: 100 },
        ctx,
      );
      const diffData = ctx.written[0].data as {
        newCount: number;
        resolvedCount: number;
      };
      // Both should be 0 — can't trust diff when either side is truncated
      assertEquals(diffData.newCount, 0);
      assertEquals(diffData.resolvedCount, 0);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// resolve_accounts tests
// =============================================================================

Deno.test({
  name: "resolve_accounts maps org accounts",
  sanitizeResources: false,
  fn: async () => {
    // Mock OrganizationsClient
    const { OrganizationsClient } = await import(
      "npm:@aws-sdk/client-organizations@3.1010.0"
    );
    const original = OrganizationsClient.prototype.send;
    OrganizationsClient.prototype.send = () =>
      Promise.resolve({
        Accounts: [
          {
            Id: "123456789012",
            Name: "prod",
            Email: "prod@example.com",
            Status: "ACTIVE",
          },
          {
            Id: "987654321098",
            Name: "dev",
            Email: "dev@example.com",
            Status: "ACTIVE",
          },
        ],
        NextToken: undefined,
      });
    try {
      const ctx = createMockContext();
      await model.methods.resolve_accounts.execute({} as never, ctx);
      const data = ctx.written[0].data as {
        accounts: Array<{ id: string; name: string }>;
        count: number;
      };
      assertEquals(data.count, 2);
      assertEquals(data.accounts[0].name, "prod");
      assertEquals(data.accounts[1].id, "987654321098");
    } finally {
      OrganizationsClient.prototype.send = original;
    }
  },
});

// =============================================================================
// list_all_findings tests
// =============================================================================

Deno.test({
  name: "list_all_findings paginates across multiple pages",
  sanitizeResources: false,
  fn: async () => {
    let callCount = 0;
    const restore = mockSecurityHub(() => {
      callCount++;
      if (callCount === 1) {
        return { Findings: [finding1], NextToken: "page2" };
      }
      return { Findings: [finding2] }; // no NextToken = last page
    });
    try {
      const ctx = createMockContext();
      await model.methods.list_all_findings.execute(
        { startTime: "24h", maxPages: 5, workflowStatus: "NEW" },
        ctx,
      );
      const data = ctx.written[0].data as {
        count: number;
        totalPages: number;
        findings: unknown[];
      };
      assertEquals(data.count, 2);
      assertEquals(data.totalPages, 2);
      assertEquals(callCount, 2);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_all_findings respects maxPages cap",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockSecurityHub(() => ({
      Findings: [finding1],
      NextToken: "always-more", // infinite pages
    }));
    try {
      const ctx = createMockContext();
      await model.methods.list_all_findings.execute(
        { startTime: "24h", maxPages: 2, workflowStatus: "NEW" },
        ctx,
      );
      const data = ctx.written[0].data as {
        count: number;
        totalPages: number;
      };
      assertEquals(data.totalPages, 2); // capped at maxPages
      assertEquals(data.count, 2); // 1 finding per page × 2 pages
    } finally {
      restore();
    }
  },
});
