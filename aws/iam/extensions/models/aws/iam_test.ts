// AWS IAM Observation Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./iam.ts";

// =============================================================================
// Model Structure Tests
// =============================================================================

Deno.test("model has correct type string", () => {
  assertEquals(model.type, "@webframp/aws/iam");
});

Deno.test("model has correct version format", () => {
  assertMatch(model.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
});

Deno.test("model exports globalArguments schema", () => {
  assertExists(model.globalArguments);
});

Deno.test("model defines expected resources", () => {
  assertExists(model.resources.roles);
  assertExists(model.resources.users);
  assertExists(model.resources.policies);
  assertExists(model.resources.trustMap);
});

Deno.test("model defines expected methods", () => {
  assertExists(model.methods.discover_roles);
  assertExists(model.methods.discover_users);
  assertExists(model.methods.discover_policies);
  assertExists(model.methods.discover_trust_map);
  assertExists(model.methods.discover_all);
});

// =============================================================================
// Resource Configuration Tests
// =============================================================================

Deno.test("roles resource has infinite lifetime", () => {
  assertEquals(model.resources.roles.lifetime, "infinite");
  assertEquals(model.resources.roles.garbageCollection, 10);
});

Deno.test("users resource has infinite lifetime", () => {
  assertEquals(model.resources.users.lifetime, "infinite");
  assertEquals(model.resources.users.garbageCollection, 10);
});

Deno.test("policies resource has infinite lifetime", () => {
  assertEquals(model.resources.policies.lifetime, "infinite");
  assertEquals(model.resources.policies.garbageCollection, 10);
});

Deno.test("trustMap resource has infinite lifetime", () => {
  assertEquals(model.resources.trustMap.lifetime, "infinite");
  assertEquals(model.resources.trustMap.garbageCollection, 10);
});

// =============================================================================
// GlobalArgs Schema Tests
// =============================================================================

Deno.test("globalArgs requires profiles", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArgs accepts profiles only (others have defaults)", () => {
  const result = model.globalArguments.safeParse({
    profiles: ["prod"],
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.pathPrefix, "/");
    assertEquals(result.data.excludeServiceLinked, true);
    assertEquals(result.data.excludeAwsManagedPolicies, true);
  }
});

Deno.test("globalArgs accepts full input", () => {
  const result = model.globalArguments.safeParse({
    profiles: ["prod", "staging"],
    pathPrefix: "/custom/",
    excludeServiceLinked: false,
    excludeAwsManagedPolicies: false,
  });
  assertEquals(result.success, true);
});

Deno.test("globalArgs rejects empty profiles array", () => {
  const result = model.globalArguments.safeParse({
    profiles: [],
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Method Argument Schema Tests
// =============================================================================

Deno.test("discover_roles accepts empty args (profiles optional)", () => {
  const result = model.methods.discover_roles.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("discover_roles accepts profiles override", () => {
  const result = model.methods.discover_roles.arguments.safeParse({
    profiles: ["prod"],
  });
  assertEquals(result.success, true);
});

Deno.test("discover_users accepts empty args", () => {
  const result = model.methods.discover_users.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("discover_policies accepts empty args", () => {
  const result = model.methods.discover_policies.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("discover_trust_map accepts empty args", () => {
  const result = model.methods.discover_trust_map.arguments.safeParse({});
  assertEquals(result.success, true);
});

Deno.test("discover_trust_map accepts profiles override", () => {
  const result = model.methods.discover_trust_map.arguments.safeParse({
    profiles: ["prod"],
  });
  assertEquals(result.success, true);
});

Deno.test("discover_all accepts empty args", () => {
  const result = model.methods.discover_all.arguments.safeParse({});
  assertEquals(result.success, true);
});

// =============================================================================
// Resource Schema Tests — truncated field
// =============================================================================

Deno.test("roles resource schema requires truncated field", () => {
  const result = model.resources.roles.schema.safeParse({
    profile: "test",
    accountId: "123456789012",
    roles: [],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, false);
});

Deno.test("roles resource schema accepts valid data with truncated", () => {
  const result = model.resources.roles.schema.safeParse({
    profile: "test",
    accountId: "123456789012",
    roles: [],
    truncated: false,
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("users resource schema requires truncated field", () => {
  const result = model.resources.users.schema.safeParse({
    profile: "test",
    accountId: "123456789012",
    users: [],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, false);
});

Deno.test("policies resource schema requires truncated field", () => {
  const result = model.resources.policies.schema.safeParse({
    profile: "test",
    accountId: "123456789012",
    policies: [],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, false);
});

// =============================================================================
// Execute Tests — discover_trust_map
// =============================================================================

function createIamContext(
  storedResources: Record<string, Record<string, unknown>> = {},
) {
  const { context, getWrittenResources, getLogsByLevel } =
    createModelTestContext({
      globalArgs: {
        profiles: ["prod"],
        pathPrefix: "/",
        excludeServiceLinked: true,
        excludeAwsManagedPolicies: true,
      },
      storedResources,
    });

  return { context, getWrittenResources, getLogsByLevel };
}

Deno.test("discover_trust_map throws when no role data exists", async () => {
  const { context } = createIamContext();

  await assertRejects(
    () =>
      model.methods.discover_trust_map.execute(
        {},
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
    Error,
    "No role data found",
  );
});

Deno.test("discover_trust_map builds trust edges from role data", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [
        {
          roleName: "cross-account-role",
          arn: "arn:aws:iam::111111111111:role/cross-account-role",
          path: "/",
          roleId: "AROA1234567890",
          description: "",
          createDate: "2026-01-01T00:00:00Z",
          lastUsed: null,
          lastUsedRegion: null,
          maxSessionDuration: 3600,
          permissionBoundary: null,
          attachedPolicies: [],
          inlinePolicies: [],
          trustPolicy: [
            {
              effect: "Allow",
              principals: [
                { type: "AWS", value: "arn:aws:iam::222222222222:root" },
              ],
              actions: ["sts:AssumeRole"],
            },
          ],
          tags: {},
          isServiceLinked: false,
        },
        {
          roleName: "service-role",
          arn: "arn:aws:iam::111111111111:role/service-role",
          path: "/",
          roleId: "AROA0987654321",
          description: "",
          createDate: "2026-01-01T00:00:00Z",
          lastUsed: null,
          lastUsedRegion: null,
          maxSessionDuration: 3600,
          permissionBoundary: null,
          attachedPolicies: [],
          inlinePolicies: [],
          trustPolicy: [
            {
              effect: "Allow",
              principals: [
                { type: "Service", value: "lambda.amazonaws.com" },
              ],
              actions: ["sts:AssumeRole"],
            },
          ],
          tags: {},
          isServiceLinked: false,
        },
      ],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "trustMap");

  const data = resources[0].data as {
    edges: unknown[];
    externalTrusts: Array<{ sourceAccount: string }>;
    serviceTrusts: Array<{ service: string }>;
    knownAccounts: string[];
  };
  assertEquals(data.knownAccounts, ["111111111111"]);
  assertEquals(data.externalTrusts.length, 1);
  assertEquals(data.externalTrusts[0].sourceAccount, "222222222222");
  assertEquals(data.serviceTrusts.length, 1);
  assertEquals(data.serviceTrusts[0].service, "lambda.amazonaws.com");
});

Deno.test("discover_trust_map uses profiles override", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [{
        roleName: "r1",
        arn: "arn:aws:iam::111111111111:role/r1",
        path: "/",
        roleId: "AROA1",
        description: "",
        createDate: "2026-01-01T00:00:00Z",
        lastUsed: null,
        lastUsedRegion: null,
        maxSessionDuration: 3600,
        permissionBoundary: null,
        attachedPolicies: [],
        inlinePolicies: [],
        trustPolicy: [],
        tags: {},
        isServiceLinked: false,
      }],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
    "roles-staging": {
      profile: "staging",
      accountId: "333333333333",
      truncated: false,
      roles: [{
        roleName: "r2",
        arn: "arn:aws:iam::333333333333:role/r2",
        path: "/",
        roleId: "AROA2",
        description: "",
        createDate: "2026-01-01T00:00:00Z",
        lastUsed: null,
        lastUsedRegion: null,
        maxSessionDuration: 3600,
        permissionBoundary: null,
        attachedPolicies: [],
        inlinePolicies: [],
        trustPolicy: [],
        tags: {},
        isServiceLinked: false,
      }],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    { profiles: ["prod"] },
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as { knownAccounts: string[] };
  assertEquals(data.knownAccounts, ["111111111111"]);
});

Deno.test("discover_trust_map succeeds with empty roles (service-linked only accounts)", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  const data = resources[0].data as {
    knownAccounts: string[];
    edges: unknown[];
  };
  assertEquals(data.knownAccounts, ["111111111111"]);
  assertEquals(data.edges, []);
});

Deno.test("discover_trust_map captures federated trust principals", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [
        {
          roleName: "github-actions-role",
          arn: "arn:aws:iam::111111111111:role/github-actions-role",
          path: "/",
          roleId: "AROA1234567890",
          description: "",
          createDate: "2026-01-01T00:00:00Z",
          lastUsed: null,
          lastUsedRegion: null,
          maxSessionDuration: 3600,
          permissionBoundary: null,
          attachedPolicies: [],
          inlinePolicies: [],
          trustPolicy: [
            {
              effect: "Allow",
              principals: [
                {
                  type: "Federated",
                  value: "token.actions.githubusercontent.com",
                },
              ],
              actions: ["sts:AssumeRoleWithWebIdentity"],
              conditions: {
                StringEquals: {
                  "token.actions.githubusercontent.com:aud":
                    "sts.amazonaws.com",
                },
              },
            },
          ],
          tags: {},
          isServiceLinked: false,
        },
      ],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    federatedTrusts: Array<{
      provider: string;
      targetRoleName: string;
      targetAccount: string;
    }>;
  };
  assertEquals(data.federatedTrusts.length, 1);
  assertEquals(
    data.federatedTrusts[0].provider,
    "token.actions.githubusercontent.com",
  );
  assertEquals(data.federatedTrusts[0].targetRoleName, "github-actions-role");
  assertEquals(data.federatedTrusts[0].targetAccount, "111111111111");
});

Deno.test("trustMap resource schema requires wildcardTrusts and federatedTrusts", () => {
  const result = model.resources.trustMap.schema.safeParse({
    edges: [],
    externalTrusts: [],
    serviceTrusts: [],
    knownAccounts: [],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, false);
});

Deno.test("trustMap resource schema accepts complete data", () => {
  const result = model.resources.trustMap.schema.safeParse({
    edges: [],
    externalTrusts: [],
    wildcardTrusts: [],
    federatedTrusts: [],
    serviceTrusts: [],
    knownAccounts: [],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, true);
});

Deno.test("discover_trust_map routes wildcard principal to wildcardTrusts", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [
        {
          roleName: "publicly-assumable",
          arn: "arn:aws:iam::111111111111:role/publicly-assumable",
          path: "/",
          roleId: "AROA9999999999",
          description: "",
          createDate: "2026-01-01T00:00:00Z",
          lastUsed: null,
          lastUsedRegion: null,
          maxSessionDuration: 3600,
          permissionBoundary: null,
          attachedPolicies: [],
          inlinePolicies: [],
          trustPolicy: [
            {
              effect: "Allow",
              principals: [{ type: "Wildcard", value: "*" }],
              actions: ["sts:AssumeRole"],
            },
          ],
          tags: {},
          isServiceLinked: false,
        },
      ],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    wildcardTrusts: Array<{
      targetRoleName: string;
      targetAccount: string;
    }>;
    externalTrusts: unknown[];
  };
  assertEquals(data.wildcardTrusts.length, 1);
  assertEquals(data.wildcardTrusts[0].targetRoleName, "publicly-assumable");
  assertEquals(data.wildcardTrusts[0].targetAccount, "111111111111");
  assertEquals(data.externalTrusts.length, 0);
});

Deno.test("discover_trust_map handles GovCloud and bare account ARNs", async () => {
  const { context, getWrittenResources } = createIamContext({
    "roles-prod": {
      profile: "prod",
      accountId: "111111111111",
      truncated: false,
      roles: [
        {
          roleName: "govcloud-trusted",
          arn: "arn:aws:iam::111111111111:role/govcloud-trusted",
          path: "/",
          roleId: "AROA1111111111",
          description: "",
          createDate: "2026-01-01T00:00:00Z",
          lastUsed: null,
          lastUsedRegion: null,
          maxSessionDuration: 3600,
          permissionBoundary: null,
          attachedPolicies: [],
          inlinePolicies: [],
          trustPolicy: [
            {
              effect: "Allow",
              principals: [
                {
                  type: "AWS",
                  value: "arn:aws-us-gov:iam::222222222222:role/GovRole",
                },
                { type: "AWS", value: "333333333333" },
              ],
              actions: ["sts:AssumeRole"],
            },
          ],
          tags: {},
          isServiceLinked: false,
        },
      ],
      fetchedAt: "2026-06-25T00:00:00Z",
    },
  });

  await model.methods.discover_trust_map.execute(
    {},
    // deno-lint-ignore no-explicit-any
    context as any,
  );

  const resources = getWrittenResources();
  const data = resources[0].data as {
    externalTrusts: Array<{ sourceAccount: string }>;
  };
  assertEquals(data.externalTrusts.length, 2);
  assertEquals(data.externalTrusts[0].sourceAccount, "222222222222");
  assertEquals(data.externalTrusts[1].sourceAccount, "333333333333");
});

// =============================================================================
// AccessKey Schema Tests — nullable createDate/ageDays
// =============================================================================

Deno.test("accessKey schema accepts null createDate and ageDays", () => {
  const result = model.resources.users.schema.safeParse({
    profile: "test",
    accountId: "123456789012",
    truncated: false,
    users: [{
      userName: "test-user",
      arn: "arn:aws:iam::123456789012:user/test-user",
      userId: "AIDA123",
      path: "/",
      createDate: "2026-01-01T00:00:00Z",
      passwordLastUsed: null,
      mfaEnabled: false,
      mfaDeviceCount: 0,
      accessKeys: [{
        accessKeyId: "AKIA1234",
        status: "Active",
        createDate: null,
        lastUsed: null,
        lastUsedService: null,
        lastUsedRegion: null,
        ageDays: null,
      }],
      attachedPolicies: [],
      inlinePolicies: [],
      tags: {},
    }],
    fetchedAt: "2026-06-25T00:00:00Z",
  });
  assertEquals(result.success, true);
});

// =============================================================================
// Method Execute Function Tests
// =============================================================================

Deno.test("all methods have execute functions", () => {
  assertEquals(typeof model.methods.discover_roles.execute, "function");
  assertEquals(typeof model.methods.discover_users.execute, "function");
  assertEquals(typeof model.methods.discover_policies.execute, "function");
  assertEquals(typeof model.methods.discover_trust_map.execute, "function");
  assertEquals(typeof model.methods.discover_all.execute, "function");
});
