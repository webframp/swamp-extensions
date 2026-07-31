// AWS Support Model Tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertMatch } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { SupportClient } from "npm:@aws-sdk/client-support@3.1096.0";
import { STSClient } from "npm:@aws-sdk/client-sts@3.1096.0";
import { model } from "./support.ts";

// =============================================================================
// Mock Helpers
// =============================================================================

// deno-lint-ignore no-explicit-any
function mockSTS(handler: (command: any) => unknown): () => void {
  const original = STSClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  STSClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    STSClient.prototype.send = original;
  };
}

// deno-lint-ignore no-explicit-any
function mockSupport(handler: (command: any) => unknown): () => void {
  const original = SupportClient.prototype.send;
  // deno-lint-ignore no-explicit-any
  SupportClient.prototype.send = function (_command: any) {
    return Promise.resolve(handler(_command));
  } as typeof original;
  return () => {
    SupportClient.prototype.send = original;
  };
}

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("model has correct type", () => {
  assertEquals(model.type, "@webframp/aws/support");
});

Deno.test("model version matches CalVer", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model has 6 resources", () => {
  assertEquals(Object.keys(model.resources).length, 6);
});

Deno.test("model has 6 methods", () => {
  assertEquals(Object.keys(model.methods).length, 6);
});

// =============================================================================
// list_cases Tests
// =============================================================================

Deno.test({
  name: "list_cases returns open cases for a profile",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-123-abc",
              displayId: "111222333",
              subject: "ECS task failures",
              status: "opened",
              severityCode: "high",
              serviceCode: "amazon-elastic-container-service",
              categoryCode: "general-guidance",
              submittedBy: "admin@example.com",
              timeCreated: "2026-07-01T10:00:00.000Z",
              ccEmailAddresses: ["team@example.com"],
              language: "en",
            },
            {
              caseId: "case-456-def",
              displayId: "444555666",
              subject: "Lambda throttling",
              status: "opened",
              severityCode: "normal",
              serviceCode: "aws-lambda",
              categoryCode: "general-guidance",
              submittedBy: "dev@example.com",
              timeCreated: "2026-07-02T12:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.list_cases.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_cases.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "caseList");
      const data = resources[0].data as {
        profile: string;
        accountId: string;
        status: string;
        cases: Array<{ caseId: string; subject: string }>;
        truncated: boolean;
      };
      assertEquals(data.accountId, "123456789012");
      assertEquals(data.status, "open");
      assertEquals(data.cases.length, 2);
      assertEquals(data.cases[0].caseId, "case-123-abc");
      assertEquals(data.cases[1].subject, "Lambda throttling");
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "list_cases paginates and respects limit",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    let callCount = 0;
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        callCount++;
        if (callCount === 1) {
          return {
            cases: [
              {
                caseId: "case-page1",
                displayId: "111",
                subject: "Page 1",
                status: "opened",
                severityCode: "normal",
                serviceCode: "general-info",
                categoryCode: "general-guidance",
                submittedBy: "user@example.com",
                timeCreated: "2026-07-01T00:00:00.000Z",
                ccEmailAddresses: [],
                language: "en",
              },
            ],
            nextToken: "page2",
          };
        }
        return {
          cases: [
            {
              caseId: "case-page2",
              displayId: "222",
              subject: "Page 2",
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-02T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.list_cases.execute(
        { limit: 2 },
        context as unknown as Parameters<
          typeof model.methods.list_cases.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        cases: Array<{ caseId: string }>;
        truncated: boolean;
      };
      assertEquals(data.cases.length, 2);
      assertEquals(data.cases[0].caseId, "case-page1");
      assertEquals(data.cases[1].caseId, "case-page2");
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "list_cases marks truncated when limit reached with more pages",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-1",
              displayId: "111",
              subject: "Case 1",
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-01T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
          nextToken: "more-pages",
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.list_cases.execute(
        { limit: 1 },
        context as unknown as Parameters<
          typeof model.methods.list_cases.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        cases: Array<{ caseId: string }>;
        truncated: boolean;
      };
      assertEquals(data.cases.length, 1);
      assertEquals(data.truncated, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "list_cases marks truncated when MAX_PAGES is the limiting factor",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    // Always return a nextToken so pagination never terminates on its own.
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-loop",
              displayId: "999",
              subject: "Loop case",
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-01T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
          nextToken: "always-more",
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.list_cases.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.list_cases.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        cases: Array<{ caseId: string }>;
        truncated: boolean;
      };
      // Capped at MAX_PAGES (20) iterations, one case per page.
      assertEquals(data.cases.length, 20);
      assertEquals(data.truncated, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

// =============================================================================
// get_case Tests
// =============================================================================

Deno.test({
  name: "get_case returns case details with communications",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "891377232878" }));
    const restoreSupport = mockSupport((command) => {
      const name = command.constructor.name;
      if (name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-891377232878-muen-2026-abc123",
              displayId: "178317700500245",
              subject: "Quota Increase: Chime SDK",
              status: "opened",
              severityCode: "critical",
              serviceCode: "service-limit-increase",
              categoryCode: "general-guidance",
              submittedBy: "admin@example.com",
              timeCreated: "2026-07-04T14:56:43.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      if (name === "DescribeCommunicationsCommand") {
        return {
          communications: [
            {
              body: "We have escalated your request.",
              submittedBy: "Amazon Web Services",
              timeCreated: "2026-07-04T16:21:06.147Z",
            },
            {
              body: "This is causing a production outage.",
              submittedBy: "admin@example.com",
              timeCreated: "2026-07-04T15:05:01.937Z",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.get_case.execute(
        { displayId: "178317700500245" },
        context as unknown as Parameters<
          typeof model.methods.get_case.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "caseDetail");
      const data = resources[0].data as {
        accountId: string;
        case: { caseId: string; displayId: string; subject: string };
        communications: Array<{ body: string; submittedBy: string }>;
        truncated: boolean;
      };
      assertEquals(data.accountId, "891377232878");
      assertEquals(
        data.case.caseId,
        "case-891377232878-muen-2026-abc123",
      );
      assertEquals(data.case.displayId, "178317700500245");
      assertEquals(data.case.subject, "Quota Increase: Chime SDK");
      assertEquals(data.communications.length, 2);
      assertEquals(
        data.communications[0].submittedBy,
        "Amazon Web Services",
      );
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "get_case throws when case not found",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return { cases: [] };
      }
      return {};
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      let threw = false;
      try {
        await model.methods.get_case.execute(
          { displayId: "000000000" },
          context as unknown as Parameters<
            typeof model.methods.get_case.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("No support case found"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "get_case throws when case has no internal ID",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: undefined,
              displayId: "999",
              subject: "Test",
              status: "opened",
              severityCode: "low",
              serviceCode: "general-info",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      let threw = false;
      try {
        await model.methods.get_case.execute(
          { displayId: "999" },
          context as unknown as Parameters<
            typeof model.methods.get_case.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("no internal case ID"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "get_case paginates communications",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    let commsCall = 0;
    const restoreSupport = mockSupport((command) => {
      const name = command.constructor.name;
      if (name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-paginate",
              displayId: "555",
              subject: "Paginated",
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-01T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      if (name === "DescribeCommunicationsCommand") {
        commsCall++;
        if (commsCall === 1) {
          return {
            communications: [
              {
                body: "First",
                submittedBy: "AWS",
                timeCreated: "2026-07-01T01:00:00Z",
              },
            ],
            nextToken: "page2",
          };
        }
        return {
          communications: [
            {
              body: "Second",
              submittedBy: "User",
              timeCreated: "2026-07-01T02:00:00Z",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.get_case.execute(
        { displayId: "555" },
        context as unknown as Parameters<
          typeof model.methods.get_case.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        communications: Array<{ body: string }>;
        truncated: boolean;
      };
      assertEquals(data.communications.length, 2);
      assertEquals(data.communications[0].body, "First");
      assertEquals(data.communications[1].body, "Second");
      assertEquals(data.truncated, false);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

// =============================================================================
// create_case Tests
// =============================================================================

Deno.test({
  name: "create_case creates a case and returns the ID",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "CreateCaseCommand") {
        assertEquals(command.input.subject, "ECS task placement failure");
        assertEquals(command.input.severityCode, "high");
        assertEquals(command.input.issueType, "technical");
        return { caseId: "case-new-123" };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.create_case.execute(
        {
          subject: "ECS task placement failure",
          body: "Tasks are failing to place in cluster prod-main",
          serviceCode: "amazon-elastic-container-service",
          categoryCode: "general-guidance",
          severityCode: "high",
        },
        context as unknown as Parameters<
          typeof model.methods.create_case.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "createResult");
      const data = resources[0].data as {
        caseId: string;
        subject: string;
        serviceCode: string;
        severityCode: string;
      };
      assertEquals(data.caseId, "case-new-123");
      assertEquals(data.subject, "ECS task placement failure");
      assertEquals(data.serviceCode, "amazon-elastic-container-service");
      assertEquals(data.severityCode, "high");
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "create_case throws when API returns no case ID",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "CreateCaseCommand") {
        return { caseId: undefined };
      }
      return {};
    });

    try {
      const { context } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      let threw = false;
      try {
        await model.methods.create_case.execute(
          {
            subject: "Test",
            body: "Test body",
            serviceCode: "general-info",
            categoryCode: "general-guidance",
          },
          context as unknown as Parameters<
            typeof model.methods.create_case.execute
          >[1],
        );
      } catch (e) {
        threw = true;
        assertEquals(
          (e as Error).message.includes("no case ID"),
          true,
        );
      }
      assertEquals(threw, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

// =============================================================================
// add_communication Tests
// =============================================================================

Deno.test({
  name: "add_communication adds a reply to a case",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "AddCommunicationToCaseCommand") {
        assertEquals(command.input.caseId, "case-abc-123");
        assertEquals(
          command.input.communicationBody,
          "Here are the logs you requested.",
        );
        return { result: true };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.add_communication.execute(
        {
          caseId: "case-abc-123",
          body: "Here are the logs you requested.",
        },
        context as unknown as Parameters<
          typeof model.methods.add_communication.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "communicationResult");
      const data = resources[0].data as {
        caseId: string;
        success: boolean;
      };
      assertEquals(data.caseId, "case-abc-123");
      assertEquals(data.success, true);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

// =============================================================================
// resolve_case Tests
// =============================================================================

Deno.test({
  name: "resolve_case resolves a case and records status transition",
  sanitizeResources: false,
  fn: async () => {
    const restoreSts = mockSTS(() => ({ Account: "123456789012" }));
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "ResolveCaseCommand") {
        assertEquals(command.input.caseId, "case-to-resolve");
        return {
          initialCaseStatus: "opened",
          finalCaseStatus: "resolved",
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["default"] },
      });

      await model.methods.resolve_case.execute(
        { caseId: "case-to-resolve" },
        context as unknown as Parameters<
          typeof model.methods.resolve_case.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "resolveResult");
      const data = resources[0].data as {
        caseId: string;
        initialStatus: string;
        finalStatus: string;
      };
      assertEquals(data.caseId, "case-to-resolve");
      assertEquals(data.initialStatus, "opened");
      assertEquals(data.finalStatus, "resolved");
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

// =============================================================================
// scan_accounts Tests
// =============================================================================

Deno.test({
  name: "scan_accounts aggregates cases across profiles",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      return { Account: stsCall === 1 ? "111111111111" : "222222222222" };
    });
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: `case-acct${stsCall}`,
              displayId: `${stsCall}00`,
              subject: `Case from account ${stsCall}`,
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-01T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["acct1", "acct2"] },
      });

      await model.methods.scan_accounts.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.scan_accounts.execute
        >[1],
      );

      const resources = getWrittenResources();
      assertEquals(resources.length, 1);
      assertEquals(resources[0].specName, "scanResult");
      const data = resources[0].data as {
        status: string;
        entries: Array<{ profile: string; accountId: string }>;
        profilesChecked: number;
        truncated: boolean;
        failedProfiles: Array<{ profile: string }>;
      };
      assertEquals(data.status, "open");
      assertEquals(data.entries.length, 2);
      assertEquals(data.profilesChecked, 2);
      assertEquals(data.truncated, false);
      assertEquals(data.failedProfiles.length, 0);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "scan_accounts skips failing profile and still writes snapshot",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) throw new Error("ExpiredToken: creds are stale");
      return { Account: "111111111111" };
    });
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return {
          cases: [
            {
              caseId: "case-good",
              displayId: "100",
              subject: "Good case",
              status: "opened",
              severityCode: "normal",
              serviceCode: "general-info",
              categoryCode: "general-guidance",
              submittedBy: "user@example.com",
              timeCreated: "2026-07-01T00:00:00.000Z",
              ccEmailAddresses: [],
              language: "en",
            },
          ],
        };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"] },
      });

      await model.methods.scan_accounts.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.scan_accounts.execute
        >[1],
      );

      const resources = getWrittenResources();
      const data = resources[0].data as {
        entries: Array<{ profile: string }>;
        failedProfiles: Array<{ profile: string; error: string }>;
        profilesChecked: number;
      };
      assertEquals(data.entries.length, 1);
      assertEquals(data.entries[0].profile, "good");
      assertEquals(data.failedProfiles.length, 1);
      assertEquals(data.failedProfiles[0].profile, "bad");
      assertMatch(data.failedProfiles[0].error, /ExpiredToken/);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "scan_accounts redacts ARNs and account IDs from failed profile errors",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) {
        throw new Error(
          "User: arn:aws:iam::123456789012:user/alice is not authorized",
        );
      }
      return { Account: "111111111111" };
    });
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return { cases: [] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"] },
      });

      await model.methods.scan_accounts.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.scan_accounts.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        failedProfiles: Array<{ error: string }>;
      };
      const err = data.failedProfiles[0].error;
      assertEquals(err.includes("arn:aws"), false);
      assertEquals(err.includes("123456789012"), false);
      assertEquals(err.includes("alice"), false);
      assertMatch(err, /not authorized/);
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});

Deno.test({
  name: "scan_accounts collapses SSO login errors",
  sanitizeResources: false,
  fn: async () => {
    let stsCall = 0;
    const restoreSts = mockSTS(() => {
      stsCall++;
      if (stsCall === 2) {
        throw new Error(
          "please login using 'granted sso login --sso-start-url " +
            "https://acme.awsapps.com/start/#'",
        );
      }
      return { Account: "111111111111" };
    });
    const restoreSupport = mockSupport((command) => {
      if (command.constructor.name === "DescribeCasesCommand") {
        return { cases: [] };
      }
      return {};
    });

    try {
      const { context, getWrittenResources } = createModelTestContext({
        globalArgs: { profiles: ["good", "bad"] },
      });

      await model.methods.scan_accounts.execute(
        {},
        context as unknown as Parameters<
          typeof model.methods.scan_accounts.execute
        >[1],
      );

      const data = getWrittenResources()[0].data as {
        failedProfiles: Array<{ error: string }>;
      };
      assertEquals(data.failedProfiles[0].error, "sso-login-required");
    } finally {
      restoreSts();
      restoreSupport();
    }
  },
});
