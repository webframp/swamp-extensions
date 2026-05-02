// AWS GuardDuty Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { GuardDutyClient } from "npm:@aws-sdk/client-guardduty@3.1010.0";
import { model } from "./guardduty.ts";

// =============================================================================
// Mock Helper
// =============================================================================

function mockGuardDuty(
  // deno-lint-ignore no-explicit-any
  handler: (command: any) => unknown,
): () => void {
  const original = GuardDutyClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  GuardDutyClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    GuardDutyClient.prototype.send = original;
  };
}

// =============================================================================
// Test Data
// =============================================================================

const finding1 = {
  Id: "f-001",
  Type: "UnauthorizedAccess:EC2/SSHBruteForce",
  Severity: 8,
  Title: "SSH brute force attack",
  Description: "Repeated SSH login attempts detected",
  AccountId: "123456789012",
  Region: "us-east-1",
  Resource: { ResourceType: "Instance" },
  Service: { Action: { ActionType: "NETWORK_CONNECTION" } },
  CreatedAt: "2026-04-01T00:00:00Z",
  UpdatedAt: "2026-04-01T01:00:00Z",
};

const finding2 = {
  Id: "f-002",
  Type: "Recon:EC2/PortProbeUnprotectedPort",
  Severity: 2,
  Title: "Port probe on unprotected port",
  Description: "Port probe detected",
  AccountId: "123456789012",
  Region: "us-east-1",
  Resource: { ResourceType: "Instance" },
  Service: {},
  CreatedAt: "2026-04-01T00:00:00Z",
  UpdatedAt: "2026-04-01T01:00:00Z",
};

const member1 = {
  AccountId: "111111111111",
  Email: "dev@example.com",
  RelationshipStatus: "Enabled",
  InvitedAt: "2026-01-01T00:00:00Z",
  UpdatedAt: "2026-04-01T00:00:00Z",
  DetectorId: "det-111",
};

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("model has correct type", () => {
  assertEquals(model.type, "@webframp/aws/guardduty");
});

Deno.test("model version matches CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has 3 resources", () => {
  assertEquals(Object.keys(model.resources).length, 3);
});

Deno.test("model has 3 methods", () => {
  assertEquals(Object.keys(model.methods).length, 3);
});

// =============================================================================
// list_findings Tests
// =============================================================================

Deno.test({
  name:
    "list_findings returns findings and applies typePrefix filter client-side",
  // SDK client creates connection pool
  sanitizeResources: false,
  fn: async () => {
    const restore = mockGuardDuty((command) => {
      const name = command.constructor.name;
      if (name === "ListDetectorsCommand") {
        return { DetectorIds: ["det-123"] };
      }
      if (name === "ListFindingsCommand") {
        return { FindingIds: ["f-001", "f-002"] };
      }
      if (name === "GetFindingsCommand") {
        return { Findings: [finding1, finding2] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
      });

      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 50, typePrefix: "UnauthorizedAccess" },
        context as unknown as Parameters<
          typeof model.methods.list_findings.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "finding_list");

      const data = resources[0].data as {
        findings: Array<{ type: string }>;
        count: number;
      };
      // Only the UnauthorizedAccess finding should pass the prefix filter
      assertEquals(data.count, 1);
      assertEquals(
        data.findings[0].type,
        "UnauthorizedAccess:EC2/SSHBruteForce",
      );
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "list_findings returns all findings when no typePrefix",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockGuardDuty((command) => {
      const name = command.constructor.name;
      if (name === "ListDetectorsCommand") {
        return { DetectorIds: ["det-123"] };
      }
      if (name === "ListFindingsCommand") {
        return { FindingIds: ["f-001", "f-002"] };
      }
      if (name === "GetFindingsCommand") {
        return { Findings: [finding1, finding2] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
      });

      await model.methods.list_findings.execute(
        { startTime: "24h", limit: 50 },
        context as unknown as Parameters<
          typeof model.methods.list_findings.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as { count: number };
      assertEquals(data.count, 2);
    } finally {
      restore();
    }
  },
});

// =============================================================================
// get_finding_details Tests
// =============================================================================

Deno.test({
  name:
    "get_finding_details returns full details with deterministic instance name",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockGuardDuty((command) => {
      const name = command.constructor.name;
      if (name === "ListDetectorsCommand") {
        return { DetectorIds: ["det-123"] };
      }
      if (name === "GetFindingsCommand") {
        return { Findings: [finding1] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
      });

      await model.methods.get_finding_details.execute(
        { findingIds: ["f-001"] },
        context as unknown as Parameters<
          typeof model.methods.get_finding_details.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "finding_details");
      // Single finding: instance name is the finding ID
      assertEquals(resources[0].name, "details-f-001");

      const data = resources[0].data as {
        findings: Array<{ id: string; resource: Record<string, unknown> }>;
      };
      assertEquals(data.findings[0].id, "f-001");
      assertEquals(data.findings[0].resource.ResourceType, "Instance");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "get_finding_details uses count for multiple findings",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockGuardDuty((command) => {
      const name = command.constructor.name;
      if (name === "ListDetectorsCommand") {
        return { DetectorIds: ["det-123"] };
      }
      if (name === "GetFindingsCommand") {
        return { Findings: [finding1, finding2] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
      });

      await model.methods.get_finding_details.execute(
        { findingIds: ["f-001", "f-002"] },
        context as unknown as Parameters<
          typeof model.methods.get_finding_details.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources[0].name, "details-2");
    } finally {
      restore();
    }
  },
});

// =============================================================================
// list_members Tests
// =============================================================================

Deno.test({
  name: "list_members returns member accounts",
  sanitizeResources: false,
  fn: async () => {
    const restore = mockGuardDuty((command) => {
      const name = command.constructor.name;
      if (name === "ListDetectorsCommand") {
        return { DetectorIds: ["det-123"] };
      }
      if (name === "ListMembersCommand") {
        return { Members: [member1] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { region: "us-east-1" },
      });

      await model.methods.list_members.execute(
        { onlyAssociated: true },
        context as unknown as Parameters<
          typeof model.methods.list_members.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources[0].specName, "member_list");
      assertEquals(resources[0].name, "members");

      const data = resources[0].data as {
        members: Array<{ accountId: string; relationshipStatus: string }>;
        count: number;
      };
      assertEquals(data.count, 1);
      assertEquals(data.members[0].accountId, "111111111111");
      assertEquals(data.members[0].relationshipStatus, "Enabled");
    } finally {
      restore();
    }
  },
});
