/**
 * Terraform / OpenTofu State Reader Model
 *
 * Reads Terraform and OpenTofu state via the CLI (`terraform show -json` or
 * `tofu show -json`) and marshals it into swamp resources keyed by resource
 * address. Supports workspace selection and binary switching between Terraform
 * and OpenTofu via global arguments.
 *
 * @module
 */

// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

// =============================================================================
// CLI Helper
// =============================================================================

/**
 * Run a terraform/tofu CLI command and return parsed JSON output.
 * The `binary` arg selects between `terraform` and `tofu`.
 */
export async function runTfCommand(
  binary: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<unknown> {
  const cmd = new Deno.Command(binary, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env,
  });
  const output = await cmd.output();
  if (!output.success) {
    const err = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`${binary} command failed: ${err}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  workDir: z.string().describe(
    "Path to the initialized Terraform/OpenTofu working directory",
  ),
  workspace: z.string().default("default").describe(
    "Terraform workspace name",
  ),
  binary: z.string().default("terraform").describe(
    "CLI binary to use: 'terraform' or 'tofu'",
  ),
});

// --- Terraform show -json resource shape ---

const TfResourceSchema = z.object({
  address: z.string(),
  mode: z.string(),
  type: z.string(),
  name: z.string(),
  providerName: z.string(),
  values: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()),
});

const TfOutputSchema = z.object({
  value: z.unknown(),
  type: z.unknown(),
  sensitive: z.boolean(),
});

const TfResourceSummarySchema = z.object({
  address: z.string(),
  type: z.string(),
  name: z.string(),
  providerName: z.string(),
  module: z.string().nullable(),
});

const TfInventorySchema = z.object({
  terraformVersion: z.string(),
  resourceCount: z.number(),
  resources: z.array(TfResourceSummarySchema),
});

// =============================================================================
// Types for raw terraform show -json output
// =============================================================================

interface RawTfResource {
  address: string;
  mode: string;
  type: string;
  name: string;
  provider_name: string;
  schema_version?: number;
  values: Record<string, unknown>;
  sensitive_values?: Record<string, unknown>;
  depends_on?: string[];
}

interface RawTfModule {
  address?: string;
  resources?: RawTfResource[];
  child_modules?: RawTfModule[];
}

interface RawTfOutput {
  value: unknown;
  type: unknown;
  sensitive: boolean;
}

interface RawTfState {
  format_version: string;
  terraform_version?: string;
  values?: {
    outputs?: Record<string, RawTfOutput>;
    root_module?: RawTfModule;
  };
}

// =============================================================================
// Helpers
// =============================================================================

/** Recursively flatten all resources from nested modules. */
function flattenResources(
  mod: RawTfModule,
  modulePath?: string,
): Array<{ resource: RawTfResource; module: string | null }> {
  const results: Array<{ resource: RawTfResource; module: string | null }> = [];

  for (const r of mod.resources ?? []) {
    results.push({ resource: r, module: modulePath ?? null });
  }

  for (const child of mod.child_modules ?? []) {
    results.push(...flattenResources(child, child.address ?? modulePath));
  }

  return results;
}

/** Build workspace env — TF_WORKSPACE selects workspace without requiring `terraform workspace select`. */
function workspaceEnv(workspace: string): Record<string, string> | undefined {
  if (workspace === "default") return undefined;
  return { TF_WORKSPACE: workspace };
}

// =============================================================================
// Method context type
// =============================================================================

type MethodContext = {
  globalArgs: {
    workDir: string;
    workspace: string;
    binary: string;
  };
  writeResource: (
    resourceName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<{ name: string }>;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
};

// =============================================================================
// Model
// =============================================================================

/**
 * The Terraform/OpenTofu state reader model definition.
 *
 * Provides three methods:
 * - `list_resources` -- enumerate all managed resources in state
 * - `read_state` -- write full resource attributes keyed by address
 * - `get_outputs` -- extract Terraform outputs (redacting sensitive values)
 */
export const model = {
  type: "@webframp/terraform",
  version: "2026.04.14.1",

  globalArguments: GlobalArgsSchema,

  resources: {
    tf_inventory: {
      description: "Summary of all Terraform-managed resources",
      schema: TfInventorySchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    tf_resource: {
      description: "Individual Terraform resource with full attribute values",
      schema: TfResourceSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
    tf_output: {
      description: "Terraform output value",
      schema: TfOutputSchema,
      lifetime: "1h" as const,
      garbageCollection: 3,
    },
  },

  methods: {
    list_resources: {
      description:
        "List all resources in Terraform state with address, type, provider, and module path",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { workDir, workspace, binary } = context.globalArgs;

        const state = await runTfCommand(
          binary,
          ["show", "-json"],
          workDir,
          workspaceEnv(workspace),
        ) as RawTfState;

        if (!state.values?.root_module) {
          const handle = await context.writeResource(
            "tf_inventory",
            "inventory",
            {
              terraformVersion: state.terraform_version ?? "unknown",
              resourceCount: 0,
              resources: [],
            },
          );
          context.logger.info("No state found", {});
          return { dataHandles: [handle] };
        }

        const flattened = flattenResources(state.values.root_module);

        const resources = flattened.map(({ resource: r, module: m }) => ({
          address: r.address,
          type: r.type,
          name: r.name,
          providerName: r.provider_name,
          module: m,
        }));

        const handle = await context.writeResource(
          "tf_inventory",
          "inventory",
          {
            terraformVersion: state.terraform_version ?? "unknown",
            resourceCount: resources.length,
            resources,
          },
        );

        context.logger.info("Found {count} resources", {
          count: resources.length,
        });
        return { dataHandles: [handle] };
      },
    },

    read_state: {
      description:
        "Read full Terraform state — writes one resource per Terraform resource keyed by address",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { workDir, workspace, binary } = context.globalArgs;

        const state = await runTfCommand(
          binary,
          ["show", "-json"],
          workDir,
          workspaceEnv(workspace),
        ) as RawTfState;

        if (!state.values?.root_module) {
          context.logger.info("No state found", {});
          return { dataHandles: [] };
        }

        const flattened = flattenResources(state.values.root_module);
        const handles = [];

        for (const { resource: r } of flattened) {
          const handle = await context.writeResource(
            "tf_resource",
            r.address,
            {
              address: r.address,
              mode: r.mode,
              type: r.type,
              name: r.name,
              providerName: r.provider_name,
              values: r.values,
              dependsOn: r.depends_on ?? [],
            },
          );
          handles.push(handle);
        }

        context.logger.info("Wrote {count} resource(s) to state", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    get_outputs: {
      description:
        "Read Terraform outputs — writes a summary resource plus one resource per output",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ) => {
        const { workDir, workspace, binary } = context.globalArgs;

        const state = await runTfCommand(
          binary,
          ["show", "-json"],
          workDir,
          workspaceEnv(workspace),
        ) as RawTfState;

        const outputs = state.values?.outputs ?? {};
        const handles = [];

        // Summary resource with all outputs
        const summary: Record<string, unknown> = {};
        for (const [name, out] of Object.entries(outputs)) {
          if (!out.sensitive) {
            summary[name] = out.value;
          } else {
            summary[name] = "***SENSITIVE***";
          }
        }
        const summaryHandle = await context.writeResource(
          "tf_output",
          "all",
          { value: summary, type: "object", sensitive: false },
        );
        handles.push(summaryHandle);

        // Individual output resources
        for (const [name, out] of Object.entries(outputs)) {
          const handle = await context.writeResource(
            "tf_output",
            name,
            {
              value: out.sensitive ? "***SENSITIVE***" : out.value,
              type: out.type,
              sensitive: out.sensitive,
            },
          );
          handles.push(handle);
        }

        context.logger.info("Found {count} output(s)", {
          count: Object.keys(outputs).length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
