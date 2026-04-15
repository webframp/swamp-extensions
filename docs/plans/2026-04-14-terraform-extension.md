# Terraform State Reader Extension Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `@webframp/terraform` swamp model extension that reads Terraform/OpenTofu state via CLI and marshals it into swamp data for CEL consumption by workflows and reports.

**Architecture:** Single model extension that shells out to `terraform show -json` (or `tofu show -json`) to read state, parses the JSON output, and writes swamp resources keyed by Terraform resource address. The model supports workspace selection and binary switching between Terraform and OpenTofu. No state mutation — read-only.

**Tech Stack:** Deno, TypeScript, Zod 4, `@systeminit/swamp-testing`, Terraform/OpenTofu CLI

---

## Context

### Terraform `show -json` Output Structure

When state exists, `terraform show -json` produces:

```json
{
  "format_version": "1.0",
  "terraform_version": "1.9.0",
  "values": {
    "outputs": {
      "vpc_id": { "value": "vpc-abc123", "type": "string", "sensitive": false }
    },
    "root_module": {
      "resources": [
        {
          "address": "aws_instance.web",
          "mode": "managed",
          "type": "aws_instance",
          "name": "web",
          "provider_name": "registry.terraform.io/hashicorp/aws",
          "schema_version": 1,
          "values": { "ami": "ami-123", "instance_type": "t3.medium" },
          "sensitive_values": {},
          "depends_on": ["aws_subnet.main"]
        }
      ],
      "child_modules": [
        {
          "address": "module.vpc",
          "resources": [ ... ],
          "child_modules": [ ... ]
        }
      ]
    }
  }
}
```

When no state exists: `{"format_version":"1.0"}` (no `values` key).

### File Structure

```
terraform/
  .swamp.yaml              # repo marker
  manifest.yaml            # extension manifest
  deno.json                # deps + tasks
  extensions/
    models/
      terraform/
        terraform.ts       # model definition
        terraform_test.ts  # model tests
```

### Existing Patterns to Follow

- **CLI model**: `github/extensions/models/github/repos.ts` — `Deno.Command` + JSON parse
- **CLI test mock**: `github/extensions/models/github/repos_test.ts` — replace `Deno.Command` class
- **Manifest**: `github/manifest.yaml`
- **CI matrix**: `.github/workflows/ci.yml`

---

### Task 1: Scaffold Extension Directory and Configuration

**Files:**
- Create: `terraform/.swamp.yaml`
- Create: `terraform/manifest.yaml`
- Create: `terraform/deno.json`

**Step 1: Create `terraform/deno.json`**

```json
{
  "tasks": {
    "check": "deno check extensions/models/terraform/*.ts",
    "lint": "deno lint extensions/models/",
    "fmt": "deno fmt extensions/models/",
    "fmt:check": "deno fmt --check extensions/models/",
    "test": "deno test --allow-run --allow-env --allow-read extensions/models/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "zod": "npm:zod@4.3.6",
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

**Step 2: Create `terraform/manifest.yaml`**

```yaml
manifestVersion: 1
name: "@webframp/terraform"
version: "2026.04.14.1"
description: |
  Read Terraform and OpenTofu state via CLI and marshal into swamp data.

  Shells out to `terraform show -json` (or `tofu show -json`) to read state
  from any configured backend, then writes swamp resources keyed by Terraform
  resource address for CEL consumption in workflows and reports.

  Supports workspace selection and binary switching between Terraform and
  OpenTofu via global arguments.

  ## Quick Start

  ```bash
  swamp extension pull @webframp/terraform
  swamp model create @webframp/terraform tf-infra \
    --global-arg workDir=/path/to/terraform/repo
  ```
repository: "https://github.com/webframp/swamp-extensions"
models:
  - terraform/terraform.ts
labels:
  - terraform
  - opentofu
  - iac
  - infrastructure
  - state
platforms:
  - linux-x86_64
  - linux-aarch64
  - darwin-x86_64
  - darwin-aarch64
```

**Step 3: Create `terraform/.swamp.yaml`**

Run: `cd terraform && swamp repo init`

Or create manually:

```yaml
extensions:
  - manifest.yaml
```

**Step 4: Commit**

```bash
git add terraform/deno.json terraform/manifest.yaml terraform/.swamp.yaml
git commit -m "feat(terraform): scaffold extension directory and config"
```

---

### Task 2: CLI Helper and Model Shell

**Files:**
- Create: `terraform/extensions/models/terraform/terraform.ts`
- Create: `terraform/extensions/models/terraform/terraform_test.ts`

This task creates the CLI helper function, the Zod schemas, and the model export with empty methods. Tests verify the model structure and the CLI helper's success/error handling.

**Step 1: Write the model file with CLI helper and schemas**

Create `terraform/extensions/models/terraform/terraform.ts`:

```typescript
// Terraform / OpenTofu State Reader Model
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
  values: z.record(z.unknown()),
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
```

**Step 2: Write tests**

Create `terraform/extensions/models/terraform/terraform_test.ts`:

```typescript
// Terraform model tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { model, runTfCommand } from "./terraform.ts";

// =============================================================================
// Mock terraform show -json output
// =============================================================================

const MOCK_STATE_WITH_RESOURCES = {
  format_version: "1.0",
  terraform_version: "1.9.0",
  values: {
    outputs: {
      vpc_id: { value: "vpc-abc123", type: "string", sensitive: false },
      db_password: { value: "secret", type: "string", sensitive: true },
    },
    root_module: {
      resources: [
        {
          address: "aws_vpc.main",
          mode: "managed",
          type: "aws_vpc",
          name: "main",
          provider_name: "registry.terraform.io/hashicorp/aws",
          schema_version: 1,
          values: { cidr_block: "10.0.0.0/16", tags: { Name: "main" } },
          sensitive_values: {},
          depends_on: [],
        },
        {
          address: "aws_subnet.public",
          mode: "managed",
          type: "aws_subnet",
          name: "public",
          provider_name: "registry.terraform.io/hashicorp/aws",
          schema_version: 1,
          values: {
            cidr_block: "10.0.1.0/24",
            vpc_id: "vpc-abc123",
            availability_zone: "us-east-1a",
          },
          sensitive_values: {},
          depends_on: ["aws_vpc.main"],
        },
      ],
      child_modules: [
        {
          address: "module.eks",
          resources: [
            {
              address: "module.eks.aws_eks_cluster.main",
              mode: "managed",
              type: "aws_eks_cluster",
              name: "main",
              provider_name: "registry.terraform.io/hashicorp/aws",
              schema_version: 0,
              values: { name: "my-cluster", version: "1.29" },
              sensitive_values: {},
              depends_on: ["aws_subnet.public"],
            },
          ],
          child_modules: [],
        },
      ],
    },
  },
};

const MOCK_EMPTY_STATE = {
  format_version: "1.0",
};

// =============================================================================
// Helper: mock Deno.Command for terraform show -json
// =============================================================================

function mockTfCommand(
  output: unknown,
  options?: { success?: boolean; stderr?: string },
) {
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    #cmd: string;
    #opts: { args?: string[]; cwd?: string; env?: Record<string, string> };
    constructor(cmd: string, opts: Record<string, unknown>) {
      this.#cmd = cmd;
      this.#opts = opts as typeof this.#opts;
    }
    async output() {
      await Promise.resolve();
      return {
        success: options?.success ?? true,
        stdout: new TextEncoder().encode(JSON.stringify(output)),
        stderr: new TextEncoder().encode(options?.stderr ?? ""),
      };
    }
  };
  return originalCommand;
}

function createTestContext(globalArgs?: Record<string, string>) {
  const written: Array<{
    resourceName: string;
    instanceName: string;
    data: unknown;
  }> = [];
  const logs: string[] = [];

  return {
    context: {
      globalArgs: {
        workDir: "/tmp/tf-project",
        workspace: "default",
        binary: "terraform",
        ...globalArgs,
      },
      writeResource: async (
        resourceName: string,
        instanceName: string,
        data: unknown,
      ) => {
        written.push({ resourceName, instanceName, data });
        return { name: instanceName };
      },
      logger: {
        info: (msg: string, _props: Record<string, unknown>) => {
          logs.push(msg);
        },
      },
    },
    getWritten: () => written,
    getLogs: () => logs,
  };
}

// =============================================================================
// Model structure tests
// =============================================================================

Deno.test("terraform model: has correct type", () => {
  assertEquals(model.type, "@webframp/terraform");
});

Deno.test("terraform model: has valid CalVer version", () => {
  const parts = model.version.split(".");
  assertEquals(parts.length, 4);
  assertEquals(parts[0].length, 4); // YYYY
});

Deno.test("terraform model: has all 3 methods", () => {
  const methods = Object.keys(model.methods);
  assertEquals(methods.sort(), ["get_outputs", "list_resources", "read_state"]);
});

Deno.test("terraform model: has all 3 resources", () => {
  const resources = Object.keys(model.resources);
  assertEquals(resources.sort(), ["tf_inventory", "tf_output", "tf_resource"]);
});

Deno.test("terraform model: globalArguments validates workDir, workspace, binary", () => {
  const result = model.globalArguments.safeParse({ workDir: "/tmp/test" });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.workspace, "default");
    assertEquals(result.data.binary, "terraform");
  }
});

// =============================================================================
// CLI helper tests
// =============================================================================

Deno.test("runTfCommand: parses JSON stdout on success", async () => {
  const restore = mockTfCommand({ format_version: "1.0" });
  try {
    const result = await runTfCommand("terraform", ["show", "-json"], "/tmp");
    assertEquals(result, { format_version: "1.0" });
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("runTfCommand: throws on CLI failure", async () => {
  const restore = mockTfCommand({}, {
    success: false,
    stderr: "Error: No configuration files",
  });
  try {
    await assertRejects(
      () => runTfCommand("terraform", ["show", "-json"], "/tmp"),
      Error,
      "terraform command failed",
    );
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("runTfCommand: uses tofu binary when specified", async () => {
  let capturedCmd = "";
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(cmd: string, _opts: Record<string, unknown>) {
      capturedCmd = cmd;
    }
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode("{}"),
        stderr: new Uint8Array(),
      };
    }
  };
  try {
    await runTfCommand("tofu", ["show", "-json"], "/tmp");
    assertEquals(capturedCmd, "tofu");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});

// =============================================================================
// list_resources tests
// =============================================================================

Deno.test("list_resources: returns inventory with flattened resources", async () => {
  const restore = mockTfCommand(MOCK_STATE_WITH_RESOURCES);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_resources.execute({} as any, context as any);
    const written = getWritten();
    assertEquals(written.length, 1);
    assertEquals(written[0].resourceName, "tf_inventory");
    assertEquals(written[0].instanceName, "inventory");
    // deno-lint-ignore no-explicit-any
    const data = written[0].data as any;
    assertEquals(data.terraformVersion, "1.9.0");
    assertEquals(data.resourceCount, 3);
    assertEquals(data.resources[0].address, "aws_vpc.main");
    assertEquals(data.resources[2].address, "module.eks.aws_eks_cluster.main");
    assertEquals(data.resources[2].module, "module.eks");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("list_resources: handles empty state gracefully", async () => {
  const restore = mockTfCommand(MOCK_EMPTY_STATE);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_resources.execute({} as any, context as any);
    const written = getWritten();
    assertEquals(written.length, 1);
    // deno-lint-ignore no-explicit-any
    const data = written[0].data as any;
    assertEquals(data.resourceCount, 0);
    assertEquals(data.resources, []);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

// =============================================================================
// read_state tests
// =============================================================================

Deno.test("read_state: writes one resource per terraform resource", async () => {
  const restore = mockTfCommand(MOCK_STATE_WITH_RESOURCES);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.read_state.execute({} as any, context as any);
    const written = getWritten();
    assertEquals(written.length, 3);
    assertEquals(written[0].instanceName, "aws_vpc.main");
    assertEquals(written[0].resourceName, "tf_resource");
    // deno-lint-ignore no-explicit-any
    const vpc = written[0].data as any;
    assertEquals(vpc.type, "aws_vpc");
    assertEquals(vpc.values.cidr_block, "10.0.0.0/16");
    assertEquals(written[1].instanceName, "aws_subnet.public");
    assertEquals(written[2].instanceName, "module.eks.aws_eks_cluster.main");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("read_state: handles empty state gracefully", async () => {
  const restore = mockTfCommand(MOCK_EMPTY_STATE);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.read_state.execute({} as any, context as any);
    assertEquals(getWritten().length, 0);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("read_state: preserves dependency information", async () => {
  const restore = mockTfCommand(MOCK_STATE_WITH_RESOURCES);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.read_state.execute({} as any, context as any);
    const written = getWritten();
    // deno-lint-ignore no-explicit-any
    const subnet = written[1].data as any;
    assertEquals(subnet.dependsOn, ["aws_vpc.main"]);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

// =============================================================================
// get_outputs tests
// =============================================================================

Deno.test("get_outputs: writes summary and individual output resources", async () => {
  const restore = mockTfCommand(MOCK_STATE_WITH_RESOURCES);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.get_outputs.execute({} as any, context as any);
    const written = getWritten();
    // 1 summary + 2 individual outputs
    assertEquals(written.length, 3);
    assertEquals(written[0].instanceName, "all");
    assertEquals(written[1].instanceName, "vpc_id");
    assertEquals(written[2].instanceName, "db_password");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("get_outputs: masks sensitive output values", async () => {
  const restore = mockTfCommand(MOCK_STATE_WITH_RESOURCES);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.get_outputs.execute({} as any, context as any);
    const written = getWritten();
    // Summary should mask sensitive values
    // deno-lint-ignore no-explicit-any
    const summary = written[0].data as any;
    assertEquals(summary.value.vpc_id, "vpc-abc123");
    assertEquals(summary.value.db_password, "***SENSITIVE***");
    // Individual sensitive output should be masked
    // deno-lint-ignore no-explicit-any
    const dbOutput = written[2].data as any;
    assertEquals(dbOutput.value, "***SENSITIVE***");
    assertEquals(dbOutput.sensitive, true);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

Deno.test("get_outputs: handles state with no outputs", async () => {
  const stateNoOutputs = {
    format_version: "1.0",
    terraform_version: "1.9.0",
    values: {
      root_module: {
        resources: [],
        child_modules: [],
      },
    },
  };
  const restore = mockTfCommand(stateNoOutputs);
  const { context, getWritten } = createTestContext();
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.get_outputs.execute({} as any, context as any);
    const written = getWritten();
    // Just the summary resource with empty value
    assertEquals(written.length, 1);
    assertEquals(written[0].instanceName, "all");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = restore;
  }
});

// =============================================================================
// Workspace tests
// =============================================================================

Deno.test("list_resources: passes TF_WORKSPACE env for non-default workspace", async () => {
  let capturedEnv: Record<string, string> | undefined;
  const originalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    constructor(_cmd: string, opts: Record<string, unknown>) {
      capturedEnv = opts.env as Record<string, string> | undefined;
    }
    async output() {
      await Promise.resolve();
      return {
        success: true,
        stdout: new TextEncoder().encode(
          JSON.stringify(MOCK_EMPTY_STATE),
        ),
        stderr: new Uint8Array(),
      };
    }
  };
  const { context } = createTestContext({ workspace: "staging" });
  try {
    // deno-lint-ignore no-explicit-any
    await model.methods.list_resources.execute({} as any, context as any);
    assertEquals(capturedEnv?.TF_WORKSPACE, "staging");
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = originalCommand;
  }
});
```

**Step 3: Run tests to verify they pass**

```bash
cd terraform
deno test --allow-run --allow-env --allow-read extensions/models/
```

Expected: All 16 tests pass.

**Step 4: Run check, lint, fmt**

```bash
deno check extensions/models/terraform/*.ts
deno lint extensions/models/
deno fmt --check extensions/models/
```

Expected: All clean.

**Step 5: Commit**

```bash
git add terraform/extensions/models/terraform/terraform.ts \
        terraform/extensions/models/terraform/terraform_test.ts
git commit -m "feat(terraform): add state reader model with list_resources, read_state, get_outputs"
```

---

### Task 3: Add CI Test Matrix Entry

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add terraform extension to CI**

Add a `terraform-check` job and a `terraform-test` job, following the same pattern as the `redmine-check` and `redmine-test` jobs:

```yaml
  terraform-check:
    name: terraform - ${{ matrix.task }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        task: [check, lint, fmt]
    defaults:
      run:
        working-directory: terraform
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: deno ${{ matrix.task }}
        run: |
          if [ "${{ matrix.task }}" = "fmt" ]; then
            deno fmt --check extensions/models/
          elif [ "${{ matrix.task }}" = "lint" ]; then
            deno lint extensions/models/
          else
            deno check extensions/models/terraform/*.ts
          fi

  terraform-test:
    name: terraform - test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: terraform
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: deno test
        run: deno test --allow-run --allow-env --allow-read extensions/models/
```

**Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add terraform extension to test matrix"
```

---

### Task 4: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add terraform to the Model Extensions table**

Add a row to the Model Extensions table:

```markdown
| [`@webframp/terraform`](terraform/) | Terraform/OpenTofu state reader — resource inventory, full state, and outputs | None (shells out to `terraform` or `tofu`) |
```

**Step 2: Add to the Installation section**

Add under the model extensions pull commands:

```bash
swamp extension pull @webframp/terraform
```

**Step 3: Add a Usage section**

Add after the existing usage sections:

```markdown
### Terraform state reader

```bash
swamp extension pull @webframp/terraform

swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo

# List all managed resources
swamp model method run tf-infra list_resources

# Read full state (one swamp resource per TF resource)
swamp model method run tf-infra read_state

# Read outputs
swamp model method run tf-infra get_outputs

# OpenTofu variant
swamp model create @webframp/terraform tf-tofu \
  --global-arg workDir=/path/to/tofu/repo \
  --global-arg binary=tofu
```

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add terraform extension to README"
```
