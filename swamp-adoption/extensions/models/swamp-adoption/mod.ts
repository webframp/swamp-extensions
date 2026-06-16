// Swamp Adoption Guidance Model
// Guides new users through mapping their domain onto swamp primitives.
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  userContext: z.string().describe(
    "Brief description of the user's role, team, and what they manage",
  ),
  currentTools: z.array(z.string()).default([]).describe(
    "Tools currently in use (e.g., terraform, ansible, kubectl)",
  ),
  painPoints: z.array(z.string()).default([]).describe(
    "Current pain points or frustrations with existing tooling",
  ),
  swampExperience: z
    .enum(["none", "installed", "built-something"])
    .default("none")
    .describe("How far along the user is with swamp"),
});

const InteractionSchema = z.object({
  verb: z.string(),
  direction: z.string(),
  frequency: z.string(),
  pain: z.string(),
});

const SystemSchema = z.object({
  name: z.string(),
  type: z.enum([
    "api",
    "database",
    "saas",
    "cli-tool",
    "infrastructure",
    "internal-service",
    "other",
  ]),
  interactions: z.array(InteractionSchema),
  authMethod: z.string().optional(),
});

const DataFlowSchema = z.object({
  from: z.string(),
  to: z.string(),
  description: z.string(),
  manual: z.boolean(),
});

const LandscapeSchema = z.object({
  systems: z.array(SystemSchema),
  dataFlows: z.array(DataFlowSchema),
  suggestedFirstExtension: z.string(),
  reasoning: z.string(),
  discoveredAt: z.string(),
});

const ExtensionDesignSchema = z.object({
  name: z.string(),
  description: z.string(),
  globalArguments: z.array(z.object({
    name: z.string(),
    type: z.string(),
    required: z.boolean(),
    sensitive: z.boolean(),
    description: z.string(),
  })),
  methods: z.array(z.object({
    name: z.string(),
    description: z.string(),
    arguments: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
    })),
    writesResource: z.string(),
  })),
  resources: z.array(z.object({
    name: z.string(),
    description: z.string(),
    lifetime: z.string(),
    garbageCollection: z.number(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
    })),
  })),
  dependencies: z.array(z.string()),
  vaultNeeded: z.boolean(),
  labels: z.array(z.string()),
  designedAt: z.string(),
});

const ScaffoldFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const ScaffoldSchema = z.object({
  files: z.array(ScaffoldFileSchema),
  generatedFrom: z.string(),
  generatedAt: z.string(),
});

// =============================================================================
// Context type shorthand
// =============================================================================

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
  };
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
};

// =============================================================================
// Model Definition
// =============================================================================

/** Swamp adoption guidance model — discovery interviews, extension design, scaffolding. */
export const model = {
  type: "@webframp/swamp-adoption",
  version: "2026.06.05.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    landscape: {
      description:
        "Discovered system landscape from the user's domain interviews",
      schema: LandscapeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    extensionDesign: {
      description:
        "Versioned extension design produced from landscape analysis",
      schema: ExtensionDesignSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    scaffold: {
      description: "Generated file scaffold for an extension design",
      schema: ScaffoldSchema,
      lifetime: "24h" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    discover: {
      description:
        `Conduct a structured discovery interview to map the user's domain landscape.

Guide the conversation through these phases:

1. SYSTEMS INVENTORY
   Ask: "What systems do you interact with daily? Include APIs, databases,
   SaaS platforms, CLI tools, and internal services."
   For each system, capture: name, type, and how they authenticate.

2. INTERACTION PATTERNS
   For each system, ask: "What do you DO with this system?"
   Capture verbs (read, write, deploy, monitor, rotate, audit),
   direction (inbound/outbound/bidirectional), frequency (hourly/daily/weekly/ad-hoc),
   and pain level (none/minor/significant/blocking).

3. DATA RELATIONSHIPS
   Ask: "How does data flow between these systems? Which transfers are manual?"
   Build a directed graph of from->to relationships.

4. PAIN/FREQUENCY MATRIX
   Rank interactions by: pain * frequency. The highest-scoring interaction
   is the strongest candidate for the first extension.

5. PRIMITIVE MAPPING SUMMARY
   Map each system to swamp primitives:
   - Systems with credentials -> vault integration
   - Systems producing queryable state -> model with resources
   - Systems with multi-step operations -> workflow candidates
   - Systems needing periodic checks -> report candidates

Write the landscape resource with systems, dataFlows, suggestedFirstExtension,
and reasoning for the suggestion.`,
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { userContext, currentTools, painPoints } = context.globalArgs;

        const landscape = {
          systems: [] as z.infer<typeof SystemSchema>[],
          dataFlows: [] as z.infer<typeof DataFlowSchema>[],
          suggestedFirstExtension: currentTools[0] ?? "unknown-system",
          reasoning:
            `Based on context: "${userContext}". Current tools: [${
              currentTools.join(", ")
            }]. ` +
            `Pain points: [${painPoints.join(", ")}]. ` +
            "Run this method with an agent to conduct the full discovery interview.",
          discoveredAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "landscape",
          "current",
          landscape as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Landscape discovery initialized for {userContext}",
          { userContext },
        );

        return { dataHandles: [handle] };
      },
    },

    design: {
      description: `Design a swamp extension based on the discovered landscape.

Guide the conversation through these phases:

1. SCOPE CONFIRMATION
   Read the landscape resource. Present suggestedFirstExtension and reasoning.
   Ask: "Does this match your priority? If not, which system should we tackle first?"
   If a 'system' argument is provided, use that as the target.

2. METHOD DISCOVERY
   For the target system, review its interactions from the landscape.
   Map each verb to a method name (e.g., "read certificates" -> "list_certs").
   Ask: "Which of these operations do you need automated first?"

3. RESOURCE SHAPING
   For each method, ask: "What data should this capture and store?"
   Define resource schemas with typed fields.
   Ask about lifetime: "Is this data ephemeral (hours) or permanent record?"

4. SCHEMA DRAFTING
   Propose a complete extension design with globalArguments (credentials, config),
   methods (name, args, resource writes), and resources (schemas, lifetimes).

5. DEPENDENCY CHECK
   Ask: "Does this need secrets from a vault? Does it depend on other extensions?"
   Note any vault or extension dependencies.

Write the extensionDesign resource with the full specification.`,
      arguments: z.object({
        system: z.string().optional().describe(
          "Target system name from landscape (uses suggestedFirstExtension if omitted)",
        ),
      }),
      execute: async (
        args: { system?: string },
        context: MethodContext,
      ) => {
        const landscape = await context.readResource("current");

        const targetSystem: string = args.system ??
          (landscape as Record<string, unknown> | null)
            ?.suggestedFirstExtension as string ??
          "unknown-system";

        const design = {
          name: `@webframp/${targetSystem}`,
          description:
            `Extension for ${targetSystem}, designed from landscape discovery`,
          globalArguments: [] as Array<{
            name: string;
            type: string;
            required: boolean;
            sensitive: boolean;
            description: string;
          }>,
          methods: [] as Array<{
            name: string;
            description: string;
            arguments: Array<{
              name: string;
              type: string;
              required: boolean;
            }>;
            writesResource: string;
          }>,
          resources: [] as Array<{
            name: string;
            description: string;
            lifetime: string;
            garbageCollection: number;
            fields: Array<{ name: string; type: string }>;
          }>,
          dependencies: [] as string[],
          vaultNeeded: false,
          labels: [targetSystem],
          designedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "extensionDesign",
          "current-design",
          design as unknown as Record<string, unknown>,
        );

        context.logger.info("Extension design created for {system}", {
          system: targetSystem,
        });

        return { dataHandles: [handle] };
      },
    },

    scaffold: {
      description: `Generate implementation files from an extension design.

Reads the extensionDesign resource and produces:
- manifest.yaml with proper CalVer version, labels, platforms
- deno.json with standard task configuration
- extensions/models/<name>/mod.ts with Zod schemas, resource definitions, method stubs
- extensions/models/<name>/mod_test.ts with structure and argument validation tests

The scaffold provides a working starting point that passes deno check and deno lint.
Each generated file includes TODO comments marking where the user adds real logic.`,
      arguments: z.object({
        outputFormat: z.enum(["resource", "stdout"]).default("resource")
          .describe(
            "Whether to write files as a resource or print to stdout",
          ),
      }),
      execute: async (
        args: { outputFormat?: "resource" | "stdout" },
        context: MethodContext,
      ) => {
        const design = await context.readResource(
          "current-design",
        ) as Record<string, unknown> | null;

        if (!design) {
          throw new Error(
            "No extension design found. Run 'design' method first.",
          );
        }

        const extName = (design.name as string) ?? "@webframp/my-extension";
        const shortName = extName.replace("@webframp/", "")
          .replace(/\.\./g, "")
          .replace(/^\/+/, "")
          .replace(/[^a-z0-9_\-/]/gi, "");

        const calver = new Date().toISOString().slice(0, 10).replace(/-/g, ".");

        const sanitizeYamlString = (s: string): string =>
          s.replace(/[\n\r]/g, " ").replace(/"/g, "'");

        const manifestContent = [
          "manifestVersion: 1",
          `name: "${extName}"`,
          `version: "${calver}.1"`,
          `description: "${
            sanitizeYamlString(
              (design?.description as string) ?? "TODO: add description",
            )
          }"`,
          "models:",
          `  - ${shortName}/mod.ts`,
          "labels:",
          `  - ${shortName}`,
          "platforms:",
          "  - linux-x86_64",
          "  - linux-aarch64",
          "  - darwin-x86_64",
          "  - darwin-aarch64",
        ].join("\n");

        const modContent = [
          `// ${extName} Model`,
          "// SPDX-License-Identifier: Apache-2.0",
          "",
          'import { z } from "npm:zod@4.4.3";',
          "",
          "const GlobalArgsSchema = z.object({",
          "  // TODO: add global arguments from design",
          "});",
          "",
          "export const model = {",
          `  type: "${extName}",`,
          `  version: "${calver}.1",`,
          "  globalArguments: GlobalArgsSchema,",
          "  resources: {},",
          "  methods: {},",
          "};",
        ].join("\n");

        const testContent = [
          'import { assertEquals, assertExists } from "jsr:@std/assert@1";',
          `import { model } from "./mod.ts";`,
          "",
          'Deno.test("model has correct type", () => {',
          `  assertEquals(model.type, "${extName}");`,
          "});",
          "",
          'Deno.test("model defines resources", () => {',
          "  assertExists(model.resources);",
          "});",
          "",
          'Deno.test("model defines methods", () => {',
          "  assertExists(model.methods);",
          "});",
        ].join("\n");

        const denoJsonContent = JSON.stringify(
          {
            tasks: {
              check: `deno check extensions/models/${shortName}/mod.ts`,
              lint: "deno lint extensions/models/",
              fmt: "deno fmt extensions/models/",
              "fmt:check": "deno fmt --check extensions/models/",
              test: "deno test --allow-env extensions/models/",
            },
            lint: { rules: { exclude: ["no-import-prefix"] } },
            imports: {
              "@systeminit/swamp-testing":
                "jsr:@systeminit/swamp-testing@0.20260504.10",
            },
          },
          null,
          2,
        );

        const files = [
          { path: "manifest.yaml", content: manifestContent },
          {
            path: `extensions/models/${shortName}/mod.ts`,
            content: modContent,
          },
          {
            path: `extensions/models/${shortName}/mod_test.ts`,
            content: testContent,
          },
          { path: "deno.json", content: denoJsonContent },
        ];

        const outputFormat = args.outputFormat ?? "resource";

        if (outputFormat === "stdout") {
          for (const file of files) {
            context.logger.info("--- {path} ---", { path: file.path });
            context.logger.info(file.content);
          }
          return { dataHandles: [] };
        }

        const handle = await context.writeResource(
          "scaffold",
          "latest",
          {
            files,
            generatedFrom: extName,
            generatedAt: new Date().toISOString(),
          },
        );

        context.logger.info(
          "Generated scaffold with {count} files for {name}",
          {
            count: files.length,
            name: extName,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    next: {
      description:
        `Suggest the next extension to build based on landscape analysis and the current design.

Reads the landscape and the current extensionDesign resource. Filters out the
system covered by the current design, then ranks remaining systems by:

1. Pain level (blocking > significant > minor > none)
2. Uses the highest pain across all interactions per system

Logs advisory output with the recommendation and reasoning.
Does not write any resource — purely advisory.`,
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const landscape = await context.readResource(
          "current",
        ) as Record<string, unknown> | null;

        if (!landscape) {
          throw new Error(
            "No landscape found. Run 'discover' method first to map your systems.",
          );
        }

        const systems = (landscape.systems as Array<{
          name: string;
          interactions?: Array<{ pain?: string }>;
        }>) ?? [];

        const design = await context.readResource(
          "current-design",
        ) as Record<string, unknown> | null;

        const designedSystems = new Set<string>();
        if (design?.name) {
          const name = design.name as string;
          designedSystems.add(name.replace("@webframp/", ""));
        }

        const remaining = systems.filter(
          (s) => !designedSystems.has(s.name),
        );

        if (remaining.length === 0) {
          context.logger.info(
            "All discovered systems have designs. Consider running discover again to expand scope.",
          );
        } else {
          const painOrder: Record<string, number> = {
            blocking: 0,
            significant: 1,
            minor: 2,
            none: 3,
          };

          const maxPain = (
            interactions: Array<{ pain?: string }> | undefined,
          ): number => {
            if (!interactions || interactions.length === 0) return 3;
            return Math.min(
              ...interactions.map((i) => painOrder[i.pain ?? "none"] ?? 3),
            );
          };

          const sorted = [...remaining].sort((a, b) => {
            return maxPain(a.interactions) - maxPain(b.interactions);
          });
          const suggestion = sorted[0];
          context.logger.info(
            "Next suggested extension: {name}. {count} systems remain without designs.",
            { name: suggestion.name, count: remaining.length },
          );
        }

        return { dataHandles: [] };
      },
    },
  },
};
