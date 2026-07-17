/**
 * Config Snapshot Report Extension
 *
 * Aggregates the latest effectiveSettings, roles, groups, organizations, and
 * directory user count from a `@webframp/anthropic/compliance` model into one
 * JSON artifact, meant to be exported to a git-tracked config repo so drift
 * and growth are visible via `git log`/`git diff` over time.
 *
 * Individual user rosters and group membership are deliberately excluded —
 * that data is SCIM/Entra-owned, not config, and carries PII. Only the total
 * directory user count is captured.
 *
 * @module
 * SPDX-License-Identifier: Apache-2.0
 */

/** Low-level data access available on all report contexts. */
interface DataRepository {
  getContent(
    modelType: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
}

/** Context provided by swamp when executing a method-scoped report. */
interface MethodReportContext {
  modelType: string;
  modelId: string;
  globalArgs: Record<string, unknown>;
  dataRepository: DataRepository;
}

interface SettingEntry {
  name: string;
  value: unknown;
}

interface RoleEntry {
  id: string;
  name: string;
  description: string | null;
}

interface GroupEntry {
  id: string;
  name: string;
  description: string | null;
  member_count: number | null;
}

interface OrganizationEntry {
  id: string;
  name: string;
  type: string | null;
}

/** Read a data record by name and JSON-parse it. Returns null if absent or unparseable. */
async function readSpec(
  repo: DataRepository,
  modelType: unknown,
  modelId: string,
  dataName: string,
): Promise<Record<string, unknown> | null> {
  let raw: Uint8Array | null;
  try {
    raw = await repo.getContent(modelType, modelId, dataName);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

/**
 * Config snapshot report — aggregates effective settings, roles, groups,
 * organizations, and directory user count into one JSON artifact, for
 * exporting into a git-tracked config repo.
 */
export const report = {
  name: "@webframp/compliance-config-snapshot",
  description:
    "Aggregate effective settings, roles, groups, organizations, and directory user count into one git-diffable config snapshot",
  scope: "method" as const,
  labels: ["anthropic", "compliance", "config", "snapshot"],

  execute: async (
    context: MethodReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    const modelType = String(context.modelType || "");
    if (!modelType.includes("anthropic/compliance")) {
      return {
        markdown: `*Report skipped: not a compliance model (${modelType})*`,
        json: { skipped: true, reason: "not-compliance-model" },
      };
    }

    const repo = context.dataRepository;
    const [settingsData, rolesData, groupsData, orgsData, usersData] =
      await Promise.all([
        readSpec(repo, context.modelType, context.modelId, "effectiveSettings"),
        readSpec(repo, context.modelType, context.modelId, "roles"),
        readSpec(repo, context.modelType, context.modelId, "groups"),
        readSpec(repo, context.modelType, context.modelId, "all"),
        readSpec(repo, context.modelType, context.modelId, "users"),
      ]);

    const json: Record<string, unknown> = {
      orgId: (settingsData?.orgId ?? rolesData?.orgId ?? groupsData?.orgId ??
        usersData?.orgId ?? context.globalArgs?.orgId ?? null) as
          | string
          | null,
    };

    const fetchedTimestamps: string[] = [];
    const markNoteTimestamp = (data: Record<string, unknown> | null) => {
      if (typeof data?.fetchedAt === "string") {
        fetchedTimestamps.push(data.fetchedAt);
      }
    };

    if (settingsData) {
      const settings = [...(settingsData.settings as SettingEntry[] ?? [])]
        .sort(byName);
      json.effectiveSettings = { settings };
      markNoteTimestamp(settingsData);
    }

    if (rolesData) {
      const roles = [...(rolesData.roles as RoleEntry[] ?? [])].sort(byName);
      json.roles = roles;
      markNoteTimestamp(rolesData);
    }

    if (groupsData) {
      const groups = [...(groupsData.groups as GroupEntry[] ?? [])].sort(
        byName,
      );
      json.groups = groups;
      markNoteTimestamp(groupsData);
    }

    if (orgsData) {
      const organizations = [
        ...(orgsData.organizations as OrganizationEntry[] ?? []),
      ].sort(byName);
      json.organizations = organizations;
      markNoteTimestamp(orgsData);
    }

    if (usersData) {
      const count = typeof usersData.count === "number"
        ? usersData.count
        : Array.isArray(usersData.users)
        ? usersData.users.length
        : 0;
      json.directoryUserCount = {
        count,
        asOf: typeof usersData.fetchedAt === "string"
          ? usersData.fetchedAt
          : null,
      };
      markNoteTimestamp(usersData);
    }

    json.capturedAt = fetchedTimestamps.length > 0
      ? [...fetchedTimestamps].sort().at(-1)!
      : null;

    const sections: string[] = [];
    sections.push("# Claude Enterprise Config Snapshot");
    sections.push("");
    sections.push(`**Org ID**: ${json.orgId ?? "unknown"}`);
    sections.push(`**Captured At**: ${json.capturedAt ?? "unknown"}`);
    sections.push("");
    if (json.effectiveSettings) {
      const n = (json.effectiveSettings as { settings: unknown[] }).settings
        .length;
      sections.push(`- Effective settings: ${n}`);
    }
    if (json.roles) {
      sections.push(`- Roles: ${(json.roles as unknown[]).length}`);
    }
    if (json.groups) {
      sections.push(`- Groups: ${(json.groups as unknown[]).length}`);
    }
    if (json.organizations) {
      sections.push(
        `- Organizations: ${(json.organizations as unknown[]).length}`,
      );
    }
    if (json.directoryUserCount) {
      sections.push(
        `- Directory users: ${
          (json.directoryUserCount as { count: number }).count
        }`,
      );
    }

    return { markdown: sections.join("\n"), json };
  },
};
