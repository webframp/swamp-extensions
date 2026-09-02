/**
 * Crew Reference context — the roster of people to crews and resources to
 * owning crews. Reference data every collector needs to tag events.
 *
 * A generic subdomain (domain-and-subdomains.md): its correctness matters
 * enormously — a wrong mapping mis-tags every event touching the resource — but
 * its logic is trivial lookup and upsert. Modeled after team-topology's
 * single-snapshot-resource style, but purpose-built: team-topology has no
 * user→crew roster and its conversational write model is the wrong shape for
 * the per-event lookup collectors need.
 *
 * State model: one snapshot resource (`reference-current`) holding all crews,
 * members, and mappings together — so a consumer reads it whole (via
 * `readResource` within the model, or `data.latest(...)` via CEL from another
 * model / workflow step). The two Go lookup ports (`CrewLookup`,
 * `UserCrewLookup`) become CEL expressions over this snapshot's arrays.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

const EXTENSION_NAME = "@webframp/devops-measurement";

// =============================================================================
// Schemas — reference entities (entities with identity + lifecycle)
// =============================================================================

const CrewSchema = z.object({
  id: z.string().describe(
    "Crew identifier (an opaque slug your organization chooses, e.g. team-a)",
  ),
  name: z.string().describe("Human-readable crew name"),
});

const MemberSchema = z.object({
  id: z.string().describe("Stable member identifier"),
  username: z.string().describe("Unique username collectors join on"),
  email: z.string().default("").describe("Member email (optional)"),
  crewId: z.string().describe("The crew this member belongs to"),
  aliases: z.array(z.string()).optional().describe(
    "Alternate identifiers this person is known by across sources (email, " +
      "Teams/Redmine display name, git author name). Each maps to this " +
      "member's canonical username so one person is one userId across GitLab, " +
      "Redmine, Teams, and CloudTrail.",
  ),
});

const MappingTypeEnum = z.enum(["project", "channel", "aws_account"]);

const CrewMappingSchema = z.object({
  crewId: z.string().describe("Crew that owns the resource"),
  mappingType: MappingTypeEnum.describe(
    "Kind of resource: project, channel, or aws_account",
  ),
  value: z.string().describe("Resource identifier owned by the crew"),
});

// --- The snapshot resource ---

const ReferenceSchema = z.object({
  crews: z.array(CrewSchema).describe("All crews"),
  members: z.array(MemberSchema).describe("All members mapped to crews"),
  mappings: z.array(CrewMappingSchema).describe(
    "Resource→crew ownership mappings",
  ),
  loadedAt: z.string().describe("ISO timestamp this reference set was loaded"),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was written",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
  unmappedProjects: z.array(z.string()).default([]).describe(
    "Projects that had members but no crewMap entry during derive — a queryable " +
      "coverage gap (their members were not rostered). Empty for load.",
  ),
});

// =============================================================================
// GlobalArgs
// =============================================================================

const GlobalArgsSchema = z.object({
  organization: z.string().default("").describe(
    "Optional label for the organization this reference set describes",
  ),
});

// =============================================================================
// Method argument schemas
// =============================================================================

const LoadArgsSchema = z.object({
  crews: z.array(CrewSchema).min(1).describe("Crews to load"),
  members: z.array(MemberSchema).default([]).describe("Members to load"),
  mappings: z.array(CrewMappingSchema).default([]).describe(
    "Resource→crew mappings to load",
  ),
});

// --- derive inputs: @webframp/gitlab list_members envelopes + crew taxonomy ---

/** A member record inside a @webframp/gitlab list_members envelope. */
const GitLabMemberSchema = z.object({
  username: z.string(),
  name: z.string().default(""),
});

/** One @webframp/gitlab list_members result envelope (per project). */
const GitLabMemberListSchema = z.object({
  project: z.string().describe(
    "Project (pathWithNamespace or id) the members belong to",
  ),
  members: z.array(GitLabMemberSchema).default([]),
});

/** The org's project→crew assignment — the taxonomy GitLab does not encode. */
const ProjectCrewSchema = z.object({
  project: z.string().describe("GitLab project (pathWithNamespace or id)"),
  crewId: z.string().describe("Crew that owns the project"),
});

const DeriveArgsSchema = z.object({
  memberLists: z.array(GitLabMemberListSchema).default([]).describe(
    "Array of @webframp/gitlab list_members envelopes (each " +
      "{ project, members: [{ username, name }] }), one per project. Wire via " +
      "CEL from each list_members instance's data.latest.",
  ),
  crewMap: z.array(ProjectCrewSchema).min(1).describe(
    "Project→crew assignment: the organization's crew taxonomy, which GitLab " +
      "does NOT encode. Maps each GitLab project (pathWithNamespace or id) to " +
      "the crew that owns it. This is the one piece derivation cannot infer " +
      "from GitLab alone.",
  ),
  crewNames: z.array(CrewSchema).default([]).describe(
    "Optional crew display names as {id, name} entries. Crews not listed " +
      "default their name to their id. (An array, not a map, so it round-trips " +
      "through the CLI's --input JSON parsing.)",
  ),
});

// =============================================================================
// Context type
// =============================================================================

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
};

const REFERENCE_INSTANCE = "reference-current";

/**
 * Validate the `(mappingType, value)` uniqueness invariant — a resource belongs
 * to exactly one crew. Faithful to the Go `UNIQUE(mapping_type, value)`
 * constraint. Throws on the first conflict with a message naming both crews so
 * a bad reference set fails loudly at load rather than silently mis-tagging.
 */
export function assertUniqueMappings(
  mappings: z.infer<typeof CrewMappingSchema>[],
): void {
  const seen = new Map<string, string>();
  for (const m of mappings) {
    const key = `${m.mappingType}\u0000${m.value}`;
    const existing = seen.get(key);
    if (existing !== undefined && existing !== m.crewId) {
      throw new Error(
        `Mapping conflict: ${m.mappingType} "${m.value}" is claimed by both ` +
          `crew "${existing}" and crew "${m.crewId}". A resource belongs to ` +
          `exactly one crew.`,
      );
    }
    seen.set(key, m.crewId);
  }
}

/**
 * Validate that every member and mapping references a known crew id. A member
 * or mapping pointing at a typo'd crew would otherwise tag events to a crew
 * that does not exist. Mirrors team-topology's referential check on team names.
 */
export function assertKnownCrews(
  crews: z.infer<typeof CrewSchema>[],
  members: z.infer<typeof MemberSchema>[],
  mappings: z.infer<typeof CrewMappingSchema>[],
): void {
  const ids = new Set(crews.map((c) => c.id));
  for (const [i, m] of members.entries()) {
    if (!ids.has(m.crewId)) {
      throw new Error(
        `members[${i}] ("${m.username}") references unknown crew "${m.crewId}". ` +
          `Known crews: ${[...ids].join(", ") || "none"}.`,
      );
    }
  }
  for (const [i, m] of mappings.entries()) {
    if (!ids.has(m.crewId)) {
      throw new Error(
        `mappings[${i}] (${m.mappingType} "${m.value}") references unknown crew ` +
          `"${m.crewId}". Known crews: ${[...ids].join(", ") || "none"}.`,
      );
    }
  }
}

/** The reference set produced by `deriveReference`: crews, members, mappings, and any GitLab projects that no crew claimed. */
export type DeriveResult = {
  crews: z.infer<typeof CrewSchema>[];
  members: z.infer<typeof MemberSchema>[];
  mappings: z.infer<typeof CrewMappingSchema>[];
  unmappedProjects: string[];
};

/**
 * Derive a crew reference from GitLab member lists plus the org's project→crew
 * taxonomy. Pure and exported for testing.
 *
 * GitLab supplies WHO (usernames + display names) and WHERE they work (project
 * membership). The caller supplies the crew TAXONOMY (project→crew), which
 * GitLab does not encode. From these:
 * - crews = the distinct crewIds in the crewMap (name from crewNames or id).
 * - members = usernames deduped across projects; each assigned to the crew of a
 *   project they are a member of; the GitLab display `name` becomes an alias so
 *   Redmine/Teams display-name identities resolve to this username for free.
 * - mappings = one `project` mapping per crewMap entry.
 *
 * A member appearing in projects owned by different crews is assigned to the
 * first (by crewMap order); real multi-crew people are rare and the reviewer
 * can correct via `load`. Projects with members but no crewMap entry are
 * reported in `unmappedProjects` so coverage gaps are visible.
 */
export function deriveReference(
  memberLists: z.infer<typeof GitLabMemberListSchema>[],
  crewMap: z.infer<typeof ProjectCrewSchema>[],
  crewNames: z.infer<typeof CrewSchema>[],
): DeriveResult {
  const projectCrew = new Map<string, string>();
  for (const pc of crewMap) projectCrew.set(pc.project, pc.crewId);

  const nameOf = new Map<string, string>();
  for (const c of crewNames) nameOf.set(c.id, c.name);

  // crews from the taxonomy
  const crewIds = new Set(crewMap.map((pc) => pc.crewId));
  const crews = [...crewIds].map((id) => ({ id, name: nameOf.get(id) ?? id }));

  // members deduped by username; first crew wins; display name -> alias
  const byUsername = new Map<
    string,
    { username: string; crewId: string; aliases: Set<string> }
  >();
  const unmapped = new Set<string>();
  for (const list of memberLists) {
    const crewId = projectCrew.get(list.project);
    if (crewId === undefined) {
      if (list.members.length > 0) unmapped.add(list.project);
      continue;
    }
    for (const m of list.members) {
      const existing = byUsername.get(m.username);
      if (existing) {
        if (m.name && m.name !== m.username) existing.aliases.add(m.name);
      } else {
        const aliases = new Set<string>();
        if (m.name && m.name !== m.username) aliases.add(m.name);
        byUsername.set(m.username, { username: m.username, crewId, aliases });
      }
    }
  }

  const members = [...byUsername.values()].map((m) => ({
    id: m.username,
    username: m.username,
    email: "",
    crewId: m.crewId,
    aliases: [...m.aliases],
  }));

  const mappings = crewMap.map((pc) => ({
    crewId: pc.crewId,
    mappingType: "project" as const,
    value: pc.project,
  }));

  return { crews, members, mappings, unmappedProjects: [...unmapped] };
}

/** Crew Reference model — roster of members→crews and resources→crews. */
export const model = {
  type: "@webframp/devops-measurement/crew-reference",
  version: "2026.09.01.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,

  resources: {
    reference: {
      description: "Snapshot of crews, members, and resource→crew mappings",
      schema: ReferenceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  methods: {
    load: {
      description:
        "Load the crew reference set: crews, members, and resource→crew " +
        "mappings. Idempotent — writes the full reference snapshot each call " +
        "(a new version), so re-running with the same data is a no-op in " +
        "effect. Enforces that a resource maps to exactly one crew and that " +
        "every member/mapping names a known crew.",
      arguments: LoadArgsSchema,
      execute: async (
        args: z.infer<typeof LoadArgsSchema>,
        context: MethodContext,
      ) => {
        const startMs = Date.now();

        assertKnownCrews(args.crews, args.members, args.mappings);
        assertUniqueMappings(args.mappings);

        const handle = await context.writeResource(
          "reference",
          REFERENCE_INSTANCE,
          {
            crews: args.crews,
            members: args.members,
            mappings: args.mappings,
            loadedAt: new Date().toISOString(),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            // load does not derive from live projects, so there is no
            // coverage gap to report — always empty.
            unmappedProjects: [],
          },
        );

        context.logger.info(
          "Crew reference loaded: {crews} crews, {members} members, {mappings} mappings",
          {
            crews: args.crews.length,
            members: args.members.length,
            mappings: args.mappings.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    derive: {
      description:
        "Derive the crew reference from @webframp/gitlab list_members " +
        "envelopes (wired via CEL) plus the organization's project→crew " +
        "taxonomy (crewMap — the one thing GitLab cannot supply). Produces " +
        "crews, members (deduped, with GitLab display names auto-added as " +
        "aliases so cross-source identities resolve), and project mappings, " +
        "then writes the same reference snapshot `load` does. Idempotent. " +
        "Reports unmappedProjects (members seen in a project with no crewMap " +
        "entry) so coverage gaps are visible.",
      arguments: DeriveArgsSchema,
      execute: async (
        args: z.infer<typeof DeriveArgsSchema>,
        context: MethodContext,
      ) => {
        const startMs = Date.now();

        const { crews, members, mappings, unmappedProjects } = deriveReference(
          args.memberLists,
          args.crewMap,
          args.crewNames,
        );

        // Same invariants as load — a derived set must be valid too.
        assertKnownCrews(crews, members, mappings);
        assertUniqueMappings(mappings);

        const handle = await context.writeResource(
          "reference",
          REFERENCE_INSTANCE,
          {
            crews,
            members,
            mappings,
            loadedAt: new Date().toISOString(),
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            unmappedProjects,
          },
        );

        if (unmappedProjects.length > 0) {
          context.logger.warn(
            "crew-reference derive: {n} project(s) had members but no crewMap " +
              "entry — their members were not rostered: {projects}",
            {
              n: unmappedProjects.length,
              projects: unmappedProjects.join(", "),
            },
          );
        }
        context.logger.info(
          "Crew reference derived: {crews} crews, {members} members, {mappings} mappings",
          {
            crews: crews.length,
            members: members.length,
            mappings: mappings.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
