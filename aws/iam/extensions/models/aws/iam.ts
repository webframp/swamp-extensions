/**
 * AWS IAM observation model for cross-account role, policy, and user inventory.
 *
 * Factory-pattern discovery across multiple AWS accounts via profiles.
 * Captures trust relationships, access key metadata, and permission boundaries.
 * Produces typed, versioned state queryable via CEL for security analysis.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";
import {
  GetAccessKeyLastUsedCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedRolePoliciesCommand,
  ListAttachedUserPoliciesCommand,
  ListMFADevicesCommand,
  ListPoliciesCommand,
  ListRolePoliciesCommand,
  ListRolesCommand,
  ListUserPoliciesCommand,
  ListUsersCommand,
} from "npm:@aws-sdk/client-iam@3.1091.0";
import {
  GetCallerIdentityCommand,
  STSClient,
} from "npm:@aws-sdk/client-sts@3.1091.0";
import { fromIni } from "npm:@aws-sdk/credential-providers@3.1091.0";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  profiles: z
    .array(z.string())
    .min(1)
    .describe("AWS CLI profile names to scan (one per account)"),
  pathPrefix: z
    .string()
    .default("/")
    .describe("IAM path prefix filter (default: / for all roles)"),
  excludeServiceLinked: z
    .boolean()
    .default(true)
    .describe("Exclude AWS service-linked roles from discovery"),
  excludeAwsManagedPolicies: z
    .boolean()
    .default(true)
    .describe("Only discover customer-managed policies"),
});

const TrustPrincipalSchema = z.object({
  type: z.enum(["AWS", "Service", "Federated", "Wildcard"]),
  value: z.string(),
});

const TrustStatementSchema = z.object({
  effect: z.string(),
  principals: z.array(TrustPrincipalSchema),
  actions: z.array(z.string()),
  conditions: z.record(z.string(), z.unknown()).optional(),
});

const RoleSchema = z.object({
  roleName: z.string(),
  arn: z.string(),
  path: z.string(),
  roleId: z.string(),
  description: z.string(),
  createDate: z.string(),
  lastUsed: z.string().nullable(),
  lastUsedRegion: z.string().nullable(),
  maxSessionDuration: z.number(),
  permissionBoundary: z.string().nullable(),
  attachedPolicies: z.array(z.object({
    policyName: z.string(),
    policyArn: z.string(),
  })),
  inlinePolicies: z.array(z.string()),
  trustPolicy: z.array(TrustStatementSchema),
  tags: z.record(z.string(), z.string()),
  isServiceLinked: z.boolean(),
});

const RolesResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  roles: z.array(RoleSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const AccessKeySchema = z.object({
  accessKeyId: z.string(),
  status: z.enum(["Active", "Inactive"]),
  createDate: z.string().nullable(),
  lastUsed: z.string().nullable(),
  lastUsedService: z.string().nullable(),
  lastUsedRegion: z.string().nullable(),
  ageDays: z.number().nullable(),
});

const UserSchema = z.object({
  userName: z.string(),
  arn: z.string(),
  userId: z.string(),
  path: z.string(),
  createDate: z.string(),
  passwordLastUsed: z.string().nullable(),
  mfaEnabled: z.boolean(),
  mfaDeviceCount: z.number(),
  accessKeys: z.array(AccessKeySchema),
  attachedPolicies: z.array(z.object({
    policyName: z.string(),
    policyArn: z.string(),
  })),
  inlinePolicies: z.array(z.string()),
  tags: z.record(z.string(), z.string()),
});

const UsersResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  users: z.array(UserSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const PolicyVersionSchema = z.object({
  policyArn: z.string(),
  policyName: z.string(),
  path: z.string(),
  defaultVersionId: z.string(),
  attachmentCount: z.number(),
  isAttachable: z.boolean(),
  createDate: z.string(),
  updateDate: z.string(),
  description: z.string(),
});

const PoliciesResourceSchema = z.object({
  profile: z.string(),
  accountId: z.string(),
  policies: z.array(PolicyVersionSchema),
  truncated: z.boolean(),
  fetchedAt: z.string(),
});

const TrustEdgeSchema = z.object({
  sourceAccount: z.string(),
  sourceArn: z.string(),
  targetRoleArn: z.string(),
  targetAccount: z.string(),
  targetRoleName: z.string(),
  actions: z.array(z.string()),
  conditions: z.record(z.string(), z.unknown()).optional(),
  externalId: z.string().nullable(),
});

const FederatedTrustSchema = z.object({
  provider: z.string(),
  targetRoleArn: z.string(),
  targetAccount: z.string(),
  targetRoleName: z.string(),
  conditions: z.record(z.string(), z.unknown()).optional(),
});

const WildcardTrustSchema = z.object({
  targetRoleArn: z.string(),
  targetAccount: z.string(),
  targetRoleName: z.string(),
  actions: z.array(z.string()),
  conditions: z.record(z.string(), z.unknown()).optional(),
});

const TrustMapResourceSchema = z.object({
  edges: z.array(TrustEdgeSchema),
  externalTrusts: z.array(TrustEdgeSchema),
  wildcardTrusts: z.array(WildcardTrustSchema),
  federatedTrusts: z.array(FederatedTrustSchema),
  serviceTrusts: z.array(z.object({
    service: z.string(),
    targetRoleArn: z.string(),
    targetAccount: z.string(),
  })),
  knownAccounts: z.array(z.string()),
  fetchedAt: z.string(),
});

const MAX_PAGES = 200;

// =============================================================================
// Helpers
// =============================================================================

function createIamClient(profile: string): IAMClient {
  const opts: Record<string, unknown> = { region: "us-east-1" };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new IAMClient(opts as { region: string });
}

function createStsClient(profile: string): STSClient {
  const opts: Record<string, unknown> = { region: "us-east-1" };
  if (profile !== "default") {
    opts.credentials = fromIni({ profile });
  }
  return new STSClient(opts as { region: string });
}

async function getAccountId(sts: STSClient): Promise<string> {
  const resp = await sts.send(new GetCallerIdentityCommand({}));
  return resp.Account ?? "unknown";
}

function parseTrustPolicy(
  document: string | Record<string, unknown> | undefined,
): z.infer<typeof TrustStatementSchema>[] {
  if (!document) return [];
  let doc: Record<string, unknown>;
  try {
    doc = typeof document === "string"
      ? JSON.parse(decodeURIComponent(document))
      : document;
  } catch {
    return [];
  }

  const statements = Array.isArray(doc.Statement)
    ? doc.Statement
    : doc.Statement
    ? [doc.Statement]
    : [];

  return statements.map((stmt: Record<string, unknown>) => {
    const principals: z.infer<typeof TrustPrincipalSchema>[] = [];
    const principal = stmt.Principal as
      | Record<string, unknown>
      | string
      | undefined;

    if (typeof principal === "string") {
      const type = principal === "*" ? "Wildcard" : "AWS";
      principals.push({ type, value: principal });
    } else if (principal) {
      for (const [type, values] of Object.entries(principal)) {
        const arr = Array.isArray(values) ? values : [values];
        for (const v of arr) {
          principals.push({
            type: type as "AWS" | "Service" | "Federated" | "Wildcard",
            value: String(v),
          });
        }
      }
    }

    const actions = stmt.Action
      ? Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action]
      : [];

    return {
      effect: String(stmt.Effect ?? "Allow"),
      principals,
      actions: actions.map(String),
      conditions: stmt.Condition as Record<string, unknown> | undefined,
    };
  });
}

function tagsToRecord(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!tags) return result;
  for (const tag of tags) {
    if (tag.Key) result[tag.Key] = tag.Value ?? "";
  }
  return result;
}

// =============================================================================
// Context interface
// =============================================================================

interface ModelContext {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
}

// =============================================================================
// Model
// =============================================================================

/** AWS IAM observation model — cross-account role, user, and policy discovery. */
export const model = {
  type: "@webframp/aws/iam",
  version: "2026.07.21.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

  resources: {
    roles: {
      description:
        "IAM roles per account with trust policies and attached permissions",
      schema: RolesResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    users: {
      description:
        "IAM users per account with MFA status and access key metadata",
      schema: UsersResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    policies: {
      description: "Customer-managed IAM policies per account",
      schema: PoliciesResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    trustMap: {
      description: "Cross-account trust graph derived from role trust policies",
      schema: TrustMapResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    discover_roles: {
      description:
        "Discover IAM roles across all configured profiles. Captures trust " +
        "policies, attached managed policies, inline policy names, last-used " +
        "timestamps, and permission boundaries. Produces one 'roles' resource per account.",
      arguments: z.object({
        profiles: z.array(z.string()).optional().describe(
          "Override: scan only these profiles (default: all configured profiles)",
        ),
      }),
      execute: async (
        args: { profiles?: string[] },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const handles = [];

        for (const profile of profiles) {
          const iam = createIamClient(profile);
          const sts = createStsClient(profile);
          try {
            const accountId = await getAccountId(sts);
            const roles: z.infer<typeof RoleSchema>[] = [];

            let marker: string | undefined;
            let pages = 0;
            let truncated = false;
            do {
              const resp = await iam.send(
                new ListRolesCommand({
                  PathPrefix: ctx.globalArgs.pathPrefix,
                  Marker: marker,
                  MaxItems: 100,
                }),
              );

              let pageHadResults = false;
              for (const role of resp.Roles ?? []) {
                const isServiceLinked = role.Path?.startsWith(
                  "/aws-service-role/",
                ) ?? false;
                if (ctx.globalArgs.excludeServiceLinked && isServiceLinked) {
                  continue;
                }
                pageHadResults = true;

                const [attachedResp, inlineResp] = await Promise.all([
                  iam.send(
                    new ListAttachedRolePoliciesCommand({
                      RoleName: role.RoleName!,
                    }),
                  ),
                  iam.send(
                    new ListRolePoliciesCommand({
                      RoleName: role.RoleName!,
                    }),
                  ),
                ]);

                roles.push({
                  roleName: role.RoleName!,
                  arn: role.Arn!,
                  path: role.Path ?? "/",
                  roleId: role.RoleId!,
                  description: role.Description ?? "",
                  createDate: role.CreateDate?.toISOString() ?? "",
                  lastUsed: role.RoleLastUsed?.LastUsedDate?.toISOString() ??
                    null,
                  lastUsedRegion: role.RoleLastUsed?.Region ?? null,
                  maxSessionDuration: role.MaxSessionDuration ?? 3600,
                  permissionBoundary:
                    role.PermissionsBoundary?.PermissionsBoundaryArn ?? null,
                  attachedPolicies: (attachedResp.AttachedPolicies ?? []).map(
                    (p) => ({
                      policyName: p.PolicyName!,
                      policyArn: p.PolicyArn!,
                    }),
                  ),
                  inlinePolicies: inlineResp.PolicyNames ?? [],
                  trustPolicy: parseTrustPolicy(
                    role.AssumeRolePolicyDocument,
                  ),
                  tags: tagsToRecord(role.Tags),
                  isServiceLinked,
                });
              }

              marker = resp.Marker;
              if (pageHadResults) pages++;
              if (pages >= MAX_PAGES && marker) {
                truncated = true;
                break;
              }
            } while (marker);

            const handle = await ctx.writeResource(
              "roles",
              `roles-${profile}`,
              {
                profile,
                accountId,
                roles,
                truncated,
                fetchedAt: new Date().toISOString(),
              } as unknown as Record<string, unknown>,
            );
            handles.push(handle);

            ctx.logger.info(
              "Discovered {count} roles in account {account} ({profile})",
              {
                count: roles.length,
                account: accountId,
                profile,
                truncated,
              },
            );
          } catch (err) {
            ctx.logger.info(
              "Failed to scan roles for profile {profile}: {err}",
              { profile, err: String(err) },
            );
          } finally {
            iam.destroy();
            sts.destroy();
          }
        }

        return { dataHandles: handles };
      },
    },

    discover_users: {
      description:
        "Discover IAM users across all configured profiles. Captures MFA " +
        "status, access key age/last-used, and attached policies. Produces " +
        "one 'users' resource per account.",
      arguments: z.object({
        profiles: z.array(z.string()).optional().describe(
          "Override: scan only these profiles (default: all configured profiles)",
        ),
      }),
      execute: async (
        args: { profiles?: string[] },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const handles = [];

        for (const profile of profiles) {
          const iam = createIamClient(profile);
          const sts = createStsClient(profile);
          try {
            const accountId = await getAccountId(sts);
            const users: z.infer<typeof UserSchema>[] = [];

            let marker: string | undefined;
            let pages = 0;
            let truncated = false;
            do {
              const resp = await iam.send(
                new ListUsersCommand({
                  PathPrefix: ctx.globalArgs.pathPrefix,
                  Marker: marker,
                  MaxItems: 100,
                }),
              );

              for (const user of resp.Users ?? []) {
                const [mfaResp, keysResp, attachedResp, inlineResp] =
                  await Promise.all([
                    iam.send(
                      new ListMFADevicesCommand({
                        UserName: user.UserName!,
                      }),
                    ),
                    iam.send(
                      new ListAccessKeysCommand({
                        UserName: user.UserName!,
                      }),
                    ),
                    iam.send(
                      new ListAttachedUserPoliciesCommand({
                        UserName: user.UserName!,
                      }),
                    ),
                    iam.send(
                      new ListUserPoliciesCommand({
                        UserName: user.UserName!,
                      }),
                    ),
                  ]);

                const accessKeys: z.infer<typeof AccessKeySchema>[] = [];
                for (const key of keysResp.AccessKeyMetadata ?? []) {
                  const lastUsedResp = await iam.send(
                    new GetAccessKeyLastUsedCommand({
                      AccessKeyId: key.AccessKeyId!,
                    }),
                  );
                  const createDate = key.CreateDate ?? null;
                  const ageDays = createDate
                    ? Math.floor(
                      (Date.now() - createDate.getTime()) /
                        (1000 * 60 * 60 * 24),
                    )
                    : null;
                  accessKeys.push({
                    accessKeyId: key.AccessKeyId!,
                    status: key.Status as "Active" | "Inactive",
                    createDate: createDate?.toISOString() ?? null,
                    lastUsed: lastUsedResp.AccessKeyLastUsed?.LastUsedDate
                      ?.toISOString() ??
                      null,
                    lastUsedService:
                      lastUsedResp.AccessKeyLastUsed?.ServiceName ?? null,
                    lastUsedRegion: lastUsedResp.AccessKeyLastUsed?.Region ??
                      null,
                    ageDays,
                  });
                }

                users.push({
                  userName: user.UserName!,
                  arn: user.Arn!,
                  userId: user.UserId!,
                  path: user.Path ?? "/",
                  createDate: user.CreateDate?.toISOString() ?? "",
                  passwordLastUsed: user.PasswordLastUsed?.toISOString() ??
                    null,
                  mfaEnabled: (mfaResp.MFADevices?.length ?? 0) > 0,
                  mfaDeviceCount: mfaResp.MFADevices?.length ?? 0,
                  accessKeys,
                  attachedPolicies: (attachedResp.AttachedPolicies ?? []).map(
                    (p) => ({
                      policyName: p.PolicyName!,
                      policyArn: p.PolicyArn!,
                    }),
                  ),
                  inlinePolicies: inlineResp.PolicyNames ?? [],
                  tags: tagsToRecord(user.Tags),
                });
              }

              marker = resp.Marker;
              pages++;
              if (pages >= MAX_PAGES && marker) {
                truncated = true;
                break;
              }
            } while (marker);

            const handle = await ctx.writeResource(
              "users",
              `users-${profile}`,
              {
                profile,
                accountId,
                users,
                truncated,
                fetchedAt: new Date().toISOString(),
              } as unknown as Record<string, unknown>,
            );
            handles.push(handle);

            ctx.logger.info(
              "Discovered {count} users in account {account} ({profile})",
              {
                count: users.length,
                account: accountId,
                profile,
                truncated,
              },
            );
          } catch (err) {
            ctx.logger.info(
              "Failed to scan users for profile {profile}: {err}",
              { profile, err: String(err) },
            );
          } finally {
            iam.destroy();
            sts.destroy();
          }
        }

        return { dataHandles: handles };
      },
    },

    discover_policies: {
      description:
        "Discover customer-managed IAM policies across all configured profiles. " +
        "Captures policy metadata (attachment count, version). Produces one " +
        "'policies' resource per account.",
      arguments: z.object({
        profiles: z.array(z.string()).optional().describe(
          "Override: scan only these profiles (default: all configured profiles)",
        ),
      }),
      execute: async (
        args: { profiles?: string[] },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const handles = [];

        for (const profile of profiles) {
          const iam = createIamClient(profile);
          const sts = createStsClient(profile);
          try {
            const accountId = await getAccountId(sts);
            const policies: z.infer<typeof PolicyVersionSchema>[] = [];

            let marker: string | undefined;
            let pages = 0;
            let truncated = false;
            do {
              const resp = await iam.send(
                new ListPoliciesCommand({
                  Scope: ctx.globalArgs.excludeAwsManagedPolicies
                    ? "Local"
                    : "All",
                  PathPrefix: ctx.globalArgs.pathPrefix,
                  Marker: marker,
                  MaxItems: 100,
                }),
              );

              for (const policy of resp.Policies ?? []) {
                policies.push({
                  policyArn: policy.Arn!,
                  policyName: policy.PolicyName!,
                  path: policy.Path ?? "/",
                  defaultVersionId: policy.DefaultVersionId ?? "v1",
                  attachmentCount: policy.AttachmentCount ?? 0,
                  isAttachable: policy.IsAttachable ?? true,
                  createDate: policy.CreateDate?.toISOString() ?? "",
                  updateDate: policy.UpdateDate?.toISOString() ?? "",
                  description: policy.Description ?? "",
                });
              }

              marker = resp.Marker;
              pages++;
              if (pages >= MAX_PAGES && marker) {
                truncated = true;
                break;
              }
            } while (marker);

            const handle = await ctx.writeResource(
              "policies",
              `policies-${profile}`,
              {
                profile,
                accountId,
                policies,
                truncated,
                fetchedAt: new Date().toISOString(),
              } as unknown as Record<string, unknown>,
            );
            handles.push(handle);

            ctx.logger.info(
              "Discovered {count} policies in account {account} ({profile})",
              {
                count: policies.length,
                account: accountId,
                profile,
                truncated,
              },
            );
          } catch (err) {
            ctx.logger.info(
              "Failed to scan policies for profile {profile}: {err}",
              { profile, err: String(err) },
            );
          } finally {
            iam.destroy();
            sts.destroy();
          }
        }

        return { dataHandles: handles };
      },
    },

    discover_trust_map: {
      description:
        "Build a cross-account trust graph from previously discovered roles. " +
        "Reads all 'roles' resources and extracts trust relationships, " +
        "categorizing them as cross-account AWS trusts, service trusts, or " +
        "external (unknown account) trusts. Run discover_roles first.",
      arguments: z.object({
        profiles: z.array(z.string()).optional().describe(
          "Override: read roles for only these profiles (default: all configured profiles)",
        ),
      }),
      execute: async (
        args: { profiles?: string[] },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const knownAccounts: string[] = [];
        const allRoles: Array<{
          accountId: string;
          role: z.infer<typeof RoleSchema>;
        }> = [];

        for (const profile of profiles) {
          const data = await ctx.readResource(`roles-${profile}`);
          if (!data) continue;

          const accountId = data.accountId as string;
          knownAccounts.push(accountId);
          const roles =
            (data.roles as z.infer<typeof RoleSchema>[] | undefined) ?? [];
          for (const role of roles) {
            allRoles.push({ accountId, role });
          }
        }

        if (knownAccounts.length === 0) {
          throw new Error(
            "No role data found. Run discover_roles first.",
          );
        }

        const edges: z.infer<typeof TrustEdgeSchema>[] = [];
        const externalTrusts: z.infer<typeof TrustEdgeSchema>[] = [];
        const wildcardTrusts: z.infer<typeof WildcardTrustSchema>[] = [];
        const federatedTrusts: z.infer<typeof FederatedTrustSchema>[] = [];
        const serviceTrusts: Array<{
          service: string;
          targetRoleArn: string;
          targetAccount: string;
        }> = [];

        for (const { accountId, role } of allRoles) {
          for (const stmt of role.trustPolicy) {
            if (stmt.effect !== "Allow") continue;

            for (const principal of stmt.principals) {
              if (principal.type === "Service") {
                serviceTrusts.push({
                  service: principal.value,
                  targetRoleArn: role.arn,
                  targetAccount: accountId,
                });
              } else if (principal.type === "Wildcard") {
                wildcardTrusts.push({
                  targetRoleArn: role.arn,
                  targetAccount: accountId,
                  targetRoleName: role.roleName,
                  actions: stmt.actions,
                  conditions: stmt.conditions,
                });
              } else if (principal.type === "Federated") {
                federatedTrusts.push({
                  provider: principal.value,
                  targetRoleArn: role.arn,
                  targetAccount: accountId,
                  targetRoleName: role.roleName,
                  conditions: stmt.conditions,
                });
              } else if (principal.type === "AWS") {
                const arnMatch = principal.value.match(
                  /arn:[^:]+:[^:]+::(\d{12}):/,
                );
                const bareAccountMatch = !arnMatch
                  ? principal.value.match(/^(\d{12})$/)
                  : null;
                const sourceAccount = arnMatch?.[1] ??
                  bareAccountMatch?.[1] ?? "unknown";

                const externalId = stmt.conditions
                  ? extractExternalId(stmt.conditions)
                  : null;

                const edge: z.infer<typeof TrustEdgeSchema> = {
                  sourceAccount,
                  sourceArn: principal.value,
                  targetRoleArn: role.arn,
                  targetAccount: accountId,
                  targetRoleName: role.roleName,
                  actions: stmt.actions,
                  conditions: stmt.conditions,
                  externalId,
                };

                if (
                  sourceAccount !== accountId &&
                  !knownAccounts.includes(sourceAccount)
                ) {
                  externalTrusts.push(edge);
                } else {
                  edges.push(edge);
                }
              }
            }
          }
        }

        const handle = await ctx.writeResource(
          "trustMap",
          "current",
          {
            edges,
            externalTrusts,
            wildcardTrusts,
            federatedTrusts,
            serviceTrusts,
            knownAccounts,
            fetchedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        );

        ctx.logger.info(
          "Trust map built: {edgeCount} known edges, {externalCount} external, " +
            "{wildcardCount} wildcard, {federatedCount} federated, {serviceCount} service",
          {
            edgeCount: edges.length,
            externalCount: externalTrusts.length,
            wildcardCount: wildcardTrusts.length,
            federatedCount: federatedTrusts.length,
            serviceCount: serviceTrusts.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    discover_all: {
      description:
        "Orchestrate full IAM discovery: roles, users, policies, then trust map. " +
        "Equivalent to running discover_roles, discover_users, discover_policies, " +
        "and discover_trust_map in sequence.",
      arguments: z.object({
        profiles: z.array(z.string()).optional().describe(
          "Override: scan only these profiles (default: all configured profiles)",
        ),
      }),
      execute: async (
        args: { profiles?: string[] },
        ctx: ModelContext,
      ) => {
        const profiles = args.profiles ?? ctx.globalArgs.profiles;
        const allHandles = [];

        const rolesResult = await model.methods.discover_roles.execute(
          { profiles },
          ctx,
        );
        allHandles.push(...rolesResult.dataHandles);

        const usersResult = await model.methods.discover_users.execute(
          { profiles },
          ctx,
        );
        allHandles.push(...usersResult.dataHandles);

        const policiesResult = await model.methods.discover_policies.execute(
          { profiles },
          ctx,
        );
        allHandles.push(...policiesResult.dataHandles);

        const trustResult = await model.methods.discover_trust_map.execute(
          { profiles },
          ctx,
        );
        allHandles.push(...trustResult.dataHandles);

        ctx.logger.info("Full IAM discovery complete across {count} accounts", {
          count: profiles.length,
        });

        return { dataHandles: allHandles };
      },
    },
  },
};

// =============================================================================
// Internal helpers
// =============================================================================

function extractExternalId(
  conditions: Record<string, unknown>,
): string | null {
  const stringEquals = conditions["StringEquals"] as
    | Record<string, unknown>
    | undefined;
  if (stringEquals?.["sts:ExternalId"]) {
    return String(stringEquals["sts:ExternalId"]);
  }
  return null;
}
