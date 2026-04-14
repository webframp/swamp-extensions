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
    constructor(_cmd: string, _opts: Record<string, unknown>) {}

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
      writeResource: (
        resourceName: string,
        instanceName: string,
        data: unknown,
      ) => {
        written.push({ resourceName, instanceName, data });
        return Promise.resolve({ name: instanceName });
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
