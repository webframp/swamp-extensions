// Terraform drift report tests
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { report } from "./drift_report.ts";

// =============================================================================
// Test helpers (same pattern as cost-audit report tests)
// =============================================================================

interface DataHandle {
  name: string;
  dataId: string;
  version: number;
}

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  dataHandles: DataHandle[];
}

async function writeStepData(
  tmpDir: string,
  modelType: string,
  modelId: string,
  dataName: string,
  version: number,
  data: unknown,
): Promise<void> {
  const dir =
    `${tmpDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/raw`, JSON.stringify(data));
}

function makeStep(
  modelName: string,
  modelType: string,
  modelId: string,
  methodName: string,
  dataHandles: DataHandle[],
): StepExecution {
  return {
    jobName: "test-job",
    stepName: `${modelName}-${methodName}`,
    modelName,
    modelType,
    modelId,
    methodName,
    status: "completed",
    dataHandles,
  };
}

function makeContext(
  tmpDir: string,
  stepExecutions: StepExecution[] = [],
) {
  return {
    workflowId: "wf-test",
    workflowRunId: "run-test",
    workflowName: "terraform-drift",
    workflowStatus: "completed",
    stepExecutions,
    repoDir: tmpDir,
    logger: {
      info: (_msg: string, _props: Record<string, unknown>) => {},
    },
  };
}

// TF model constants
const TF_MODEL_TYPE = "@webframp/terraform";
const TF_MODEL_ID = "tf-test-id";

// AWS model constants
const INV_MODEL_TYPE = "@webframp/aws/inventory";
const INV_MODEL_ID = "inv-test-id";
const NET_MODEL_TYPE = "@webframp/aws/networking";
const NET_MODEL_ID = "net-test-id";

// =============================================================================
// Report structure tests
// =============================================================================

Deno.test("report: has correct name, scope, and labels", () => {
  assertEquals(report.name, "@webframp/terraform-drift-report");
  assertEquals(report.scope, "workflow");
  assertStringIncludes(report.labels.join(","), "drift");
  assertStringIncludes(report.labels.join(","), "terraform");
});

// =============================================================================
// No drift scenario
// =============================================================================

Deno.test("report: no drift when TF and AWS match", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    // Write TF inventory
    await writeStepData(tmpDir, TF_MODEL_TYPE, TF_MODEL_ID, "inventory", 1, {
      terraformVersion: "1.14.6",
      resourceCount: 1,
      resources: [
        {
          address: "aws_instance.web",
          type: "aws_instance",
          name: "web",
          providerName: "registry.terraform.io/hashicorp/aws",
          module: null,
        },
      ],
    });

    // Write TF resource (read_state output)
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_instance.web",
      1,
      {
        address: "aws_instance.web",
        mode: "managed",
        type: "aws_instance",
        name: "web",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          id: "i-abc123",
          instance_type: "t3.micro",
          tags: { Name: "web" },
        },
        dependsOn: [],
      },
    );

    // Write AWS inventory (matching)
    await writeStepData(
      tmpDir,
      INV_MODEL_TYPE,
      INV_MODEL_ID,
      "all-us-east-1",
      1,
      {
        region: "us-east-1",
        resourceType: "all",
        resources: {
          ec2: [
            {
              instanceId: "i-abc123",
              instanceType: "t3.micro",
              state: "running",
              tags: { Name: "web" },
            },
          ],
        },
        count: 1,
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "list_resources", [
        { name: "inventory", dataId: "d1", version: 1 },
      ]),
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_instance.web", dataId: "d2", version: 1 },
      ]),
      makeStep(
        "aws-inventory",
        INV_MODEL_TYPE,
        INV_MODEL_ID,
        "inventory_all",
        [{ name: "all-us-east-1", dataId: "d3", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "No Drift Detected");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.driftedResources, 0);
    assertEquals(json.summary.comparedResources, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Instance type drift
// =============================================================================

Deno.test("report: detects instance type drift", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_instance.web",
      1,
      {
        address: "aws_instance.web",
        mode: "managed",
        type: "aws_instance",
        name: "web",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          id: "i-abc123",
          instance_type: "t3.micro",
          tags: { Name: "web" },
        },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      INV_MODEL_TYPE,
      INV_MODEL_ID,
      "all-us-east-1",
      1,
      {
        region: "us-east-1",
        resourceType: "all",
        resources: {
          ec2: [
            {
              instanceId: "i-abc123",
              instanceType: "t3.large",
              state: "running",
              tags: { Name: "web" },
            },
          ],
        },
        count: 1,
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_instance.web", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-inventory",
        INV_MODEL_TYPE,
        INV_MODEL_ID,
        "inventory_all",
        [{ name: "all-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "Field-Level Drift");
    assertStringIncludes(result.markdown, "instance_type");
    assertStringIncludes(result.markdown, "t3.micro");
    assertStringIncludes(result.markdown, "t3.large");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.fieldDrifts, 1);
    assertEquals(json.findings[0].status, "field_drift");
    assertEquals(json.findings[0].fields[0].field, "instance_type");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Missing in AWS
// =============================================================================

Deno.test("report: detects resource missing in AWS", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_instance.web",
      1,
      {
        address: "aws_instance.web",
        mode: "managed",
        type: "aws_instance",
        name: "web",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: { id: "i-deleted", instance_type: "t3.micro" },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      INV_MODEL_TYPE,
      INV_MODEL_ID,
      "all-us-east-1",
      1,
      {
        region: "us-east-1",
        resourceType: "all",
        resources: { ec2: [] },
        count: 0,
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_instance.web", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-inventory",
        INV_MODEL_TYPE,
        INV_MODEL_ID,
        "inventory_all",
        [{ name: "all-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "Missing in AWS");
    assertStringIncludes(result.markdown, "i-deleted");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.missingInAws, 1);
    assertEquals(json.findings[0].status, "missing_in_aws");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Tag drift
// =============================================================================

Deno.test("report: detects tag drift", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_instance.web",
      1,
      {
        address: "aws_instance.web",
        mode: "managed",
        type: "aws_instance",
        name: "web",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          id: "i-abc123",
          instance_type: "t3.micro",
          tags: { Name: "web", Environment: "prod" },
        },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      INV_MODEL_TYPE,
      INV_MODEL_ID,
      "all-us-east-1",
      1,
      {
        region: "us-east-1",
        resourceType: "all",
        resources: {
          ec2: [
            {
              instanceId: "i-abc123",
              instanceType: "t3.micro",
              state: "running",
              tags: { Name: "web", Environment: "staging" },
            },
          ],
        },
        count: 1,
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_instance.web", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-inventory",
        INV_MODEL_TYPE,
        INV_MODEL_ID,
        "inventory_all",
        [{ name: "all-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "tags.Environment");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.findings[0].fields[0].field, "tags.Environment");
    assertEquals(json.findings[0].fields[0].terraform, "prod");
    assertEquals(json.findings[0].fields[0].aws, "staging");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// NAT gateway drift
// =============================================================================

Deno.test("report: compares NAT gateway resources", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_nat_gateway.main",
      1,
      {
        address: "aws_nat_gateway.main",
        mode: "managed",
        type: "aws_nat_gateway",
        name: "main",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          id: "nat-abc123",
          subnet_id: "subnet-old",
          tags: { Name: "nat" },
        },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      NET_MODEL_TYPE,
      NET_MODEL_ID,
      "nat-gateways-us-east-1",
      1,
      {
        region: "us-east-1",
        queryType: "nat_gateways",
        data: [
          {
            natGatewayId: "nat-abc123",
            state: "available",
            vpcId: "vpc-123",
            subnetId: "subnet-new",
            tags: { Name: "nat" },
          },
        ],
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_nat_gateway.main", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-networking",
        NET_MODEL_TYPE,
        NET_MODEL_ID,
        "list_nat_gateways",
        [{ name: "nat-gateways-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "subnet_id");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.findings[0].fields[0].field, "subnet_id");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Load balancer comparison
// =============================================================================

Deno.test("report: compares load balancer resources", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_lb.main",
      1,
      {
        address: "aws_lb.main",
        mode: "managed",
        type: "aws_lb",
        name: "main",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          arn:
            "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/test/abc",
          name: "test-alb",
          internal: false,
        },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      NET_MODEL_TYPE,
      NET_MODEL_ID,
      "load-balancers-us-east-1",
      1,
      {
        region: "us-east-1",
        queryType: "load_balancers",
        data: [
          {
            arn:
              "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/test/abc",
            name: "test-alb",
            type: "application",
            scheme: "internet-facing",
            vpcId: "vpc-123",
            state: "active",
          },
        ],
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_lb.main", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-networking",
        NET_MODEL_TYPE,
        NET_MODEL_ID,
        "list_load_balancers",
        [{ name: "load-balancers-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "No Drift Detected");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.driftedResources, 0);
    assertEquals(json.summary.comparedResources, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Unsupported types are skipped
// =============================================================================

Deno.test("report: skips unsupported resource types", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_vpc.main",
      1,
      {
        address: "aws_vpc.main",
        mode: "managed",
        type: "aws_vpc",
        name: "main",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: { id: "vpc-123", cidr_block: "10.0.0.0/16" },
        dependsOn: [],
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_vpc.main", dataId: "d1", version: 1 },
      ]),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.unsupportedTypes, 1);
    assertEquals(json.summary.comparedResources, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Data source resources are excluded
// =============================================================================

Deno.test("report: excludes data source resources", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "data.aws_ami.al2023",
      1,
      {
        address: "data.aws_ami.al2023",
        mode: "data",
        type: "aws_ami",
        name: "al2023",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: { id: "ami-123" },
        dependsOn: [],
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "data.aws_ami.al2023", dataId: "d1", version: 1 },
      ]),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.totalTfResources, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Empty state
// =============================================================================

Deno.test("report: handles no step data gracefully", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = makeContext(tmpDir, []);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "No Drift Detected");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.totalTfResources, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// EIP comparison
// =============================================================================

Deno.test("report: detects missing EIP in AWS", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await writeStepData(
      tmpDir,
      TF_MODEL_TYPE,
      TF_MODEL_ID,
      "aws_eip.nat",
      1,
      {
        address: "aws_eip.nat",
        mode: "managed",
        type: "aws_eip",
        name: "nat",
        providerName: "registry.terraform.io/hashicorp/aws",
        values: {
          id: "eipalloc-gone",
          allocation_id: "eipalloc-gone",
          public_ip: "1.2.3.4",
        },
        dependsOn: [],
      },
    );

    await writeStepData(
      tmpDir,
      NET_MODEL_TYPE,
      NET_MODEL_ID,
      "elastic-ips-us-east-1",
      1,
      {
        region: "us-east-1",
        queryType: "elastic_ips",
        data: [],
        fetchedAt: new Date().toISOString(),
      },
    );

    const steps: StepExecution[] = [
      makeStep("tf-infra", TF_MODEL_TYPE, TF_MODEL_ID, "read_state", [
        { name: "aws_eip.nat", dataId: "d1", version: 1 },
      ]),
      makeStep(
        "aws-networking",
        NET_MODEL_TYPE,
        NET_MODEL_ID,
        "list_elastic_ips",
        [{ name: "elastic-ips-us-east-1", dataId: "d2", version: 1 }],
      ),
    ];

    const ctx = makeContext(tmpDir, steps);
    const result = await report.execute(ctx);

    assertStringIncludes(result.markdown, "Missing in AWS");
    assertStringIncludes(result.markdown, "eipalloc-gone");
    // deno-lint-ignore no-explicit-any
    const json = result.json as any;
    assertEquals(json.summary.missingInAws, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
