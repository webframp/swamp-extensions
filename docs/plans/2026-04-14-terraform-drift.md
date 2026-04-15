# AWS Terraform Drift Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `@webframp/aws/terraform-drift` workflow+report extension that compares Terraform state against live AWS state to detect configuration drift.

**Architecture:** A workflow orchestrates data collection from two models — `@webframp/terraform` (TF state via CLI) and `@webframp/aws/inventory` + `@webframp/aws/networking` (live AWS state via SDK). A workflow-scoped report reads both datasets, matches resources by ID, compares key fields, and produces a drift summary in markdown+JSON. Follows the `aws/cost-audit` pattern for workflow+report extensions.

**Tech Stack:** Deno, TypeScript, YAML workflows, `@systeminit/swamp-testing`

---

## Context

### Data Shape: Terraform State (from `@webframp/terraform`)

`read_state` writes one `tf_resource` per TF resource. Each has:
```json
{
  "address": "aws_instance.web",
  "mode": "managed",
  "type": "aws_instance",
  "name": "web",
  "providerName": "registry.terraform.io/hashicorp/aws",
  "values": { "id": "i-xxx", "instance_type": "t3.micro", "tags": {...} },
  "dependsOn": [...]
}
```

`list_resources` writes one `tf_inventory` with all resource summaries.

### Data Shape: AWS Inventory (from `@webframp/aws/inventory`)

`inventory_all` writes a single `inventory` resource `all-{region}`:
```json
{
  "region": "us-east-1",
  "resourceType": "all",
  "resources": {
    "ec2": [{ "instanceId": "i-xxx", "instanceType": "t3.micro", "state": "running", "tags": {...} }],
    "rds": [...],
    "lambda": [...]
  }
}
```

`list_ec2` writes `ec2-{region}` with `{ resources: [...] }`.

### Data Shape: AWS Networking (from `@webframp/aws/networking`)

Each method writes a `networking` resource with `{ data: [...] }`:
- `list_nat_gateways` → `nat-gateways-{region}`: `{ natGatewayId, state, vpcId, subnetId, tags }`
- `list_load_balancers` → `load-balancers-{region}`: `{ arn, name, type, scheme, vpcId, state, targetGroups }`
- `list_elastic_ips` → `elastic-ips-{region}`: `{ allocationId, publicIp, isAttached, tags }`

### Resource ID Mapping (TF → AWS)

| TF Type | TF ID Path | AWS Source | AWS ID Field |
|---------|-----------|------------|--------------|
| `aws_instance` | `values.id` | inventory `resources.ec2` | `instanceId` |
| `aws_nat_gateway` | `values.id` | networking `nat-gateways` | `natGatewayId` |
| `aws_lb` | `values.arn` | networking `load-balancers` | `arn` |
| `aws_eip` | `values.allocation_id` | networking `elastic-ips` | `allocationId` |

### Comparison Fields Per Resource Type

| TF Type | Fields to Compare |
|---------|------------------|
| `aws_instance` | `instance_type` ↔ `instanceType`, `tags` ↔ `tags` |
| `aws_nat_gateway` | `subnet_id` ↔ `subnetId`, `tags` ↔ `tags` |
| `aws_lb` | `name` ↔ `name`, `internal` ↔ `scheme` (internet-facing vs internal), `tags` (if available) |
| `aws_eip` | `public_ip` ↔ `publicIp`, `tags` ↔ `tags` |

### File Structure

```
aws/terraform-drift/
  .swamp.yaml              # repo marker
  manifest.yaml            # extension manifest
  deno.json                # deps + tasks
  workflows/
    terraform-drift.yaml   # orchestration workflow
  extensions/
    reports/
      drift_report.ts      # drift comparison report
      drift_report_test.ts # tests
```

### Existing Patterns to Follow

- **Workflow+Report**: `aws/cost-audit/` — manifest, workflow YAML, report TS
- **Workflow structure**: `aws/cost-audit/workflows/cost-audit.yaml` — jobs, steps, model_method tasks
- **Report pattern**: `aws/cost-audit/extensions/reports/cost_audit_report.ts` — WorkflowReportContext, getData, findStepData
- **Report tests**: `aws/cost-audit/extensions/reports/cost_audit_report_test.ts` — temp dir, writeStepData, makeStep, makeContext

---

### Task 1: Scaffold Extension Directory

**Files:**
- Create: `aws/terraform-drift/.swamp.yaml`
- Create: `aws/terraform-drift/manifest.yaml`
- Create: `aws/terraform-drift/deno.json`

**Step 1: Create `aws/terraform-drift/deno.json`**

```json
{
  "tasks": {
    "check": "deno check extensions/reports/drift_report.ts",
    "lint": "deno lint extensions/reports/",
    "fmt": "deno fmt extensions/reports/",
    "fmt:check": "deno fmt --check extensions/reports/",
    "test": "deno test --allow-env --allow-read --allow-write extensions/reports/"
  },
  "lint": {
    "rules": {
      "exclude": ["no-import-prefix"]
    }
  },
  "imports": {
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing@0.20260331.5"
  }
}
```

**Step 2: Create `aws/terraform-drift/manifest.yaml`**

```yaml
manifestVersion: 1
name: "@webframp/aws/terraform-drift"
version: "2026.04.14.1"
description: |
  Terraform drift detection for AWS — compares Terraform state against live
  AWS resources to find configuration drift.

  Orchestrates data collection from @webframp/terraform (state via CLI) and
  @webframp/aws/inventory + @webframp/aws/networking (live AWS via SDK),
  then produces a drift report highlighting missing, extra, and changed resources.

  ## Quick Start

  ```bash
  swamp extension pull @webframp/aws/terraform-drift

  swamp model create @webframp/terraform tf-infra \
    --global-arg workDir=/path/to/terraform/repo
  swamp model create @webframp/aws/inventory aws-inventory \
    --global-arg region=us-east-1
  swamp model create @webframp/aws/networking aws-networking \
    --global-arg region=us-east-1

  swamp workflow run @webframp/terraform-drift
  ```
repository: "https://github.com/webframp/swamp-extensions"
workflows:
  - terraform-drift.yaml
reports:
  - drift_report.ts
labels:
  - aws
  - terraform
  - drift
  - compliance
  - iac
dependencies:
  - "@webframp/terraform@2026.04.14.1"
  - "@webframp/aws/inventory@2026.03.31.1"
  - "@webframp/aws/networking@2026.04.12.1"
```

**Step 3: Create `aws/terraform-drift/.swamp.yaml`**

Run: `cd aws/terraform-drift && swamp repo init`

Or create manually:
```yaml
extensions:
  - manifest.yaml
```

**Step 4: Commit**

```bash
git add aws/terraform-drift/deno.json aws/terraform-drift/manifest.yaml aws/terraform-drift/.swamp.yaml
git commit -m "feat(aws/terraform-drift): scaffold extension directory and config"
```

---

### Task 2: Workflow Definition

**Files:**
- Create: `aws/terraform-drift/workflows/terraform-drift.yaml`

**Step 1: Create the workflow YAML**

This workflow has two jobs: `gather-terraform-state` runs the terraform model methods, then `gather-aws-live-state` runs in parallel to collect live AWS data. The report runs after both complete.

Create `aws/terraform-drift/workflows/terraform-drift.yaml`:

```yaml
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
name: "@webframp/terraform-drift"
description: |
  Compare Terraform state against live AWS resources to detect drift.
  Collects Terraform-declared state via CLI, then gathers live AWS
  resource data, and produces a drift report.
tags:
  terraform: "true"
  drift: "true"
  aws: "true"
  compliance: "true"
reports:
  require:
    - "@webframp/terraform-drift-report"
inputs:
  properties:
    region:
      type: string
      default: us-east-1
      description: AWS region to check for drift
  required: []
jobs:
  - name: gather-terraform-state
    description: Read Terraform state and resource inventory
    steps:
      - name: tf-list-resources
        description: List all resources in Terraform state
        task:
          type: model_method
          modelIdOrName: tf-infra
          methodName: list_resources
        allowFailure: false

      - name: tf-read-state
        description: Read full Terraform state with all resource attributes
        task:
          type: model_method
          modelIdOrName: tf-infra
          methodName: read_state
        allowFailure: false

      - name: tf-get-outputs
        description: Read Terraform output values
        task:
          type: model_method
          modelIdOrName: tf-infra
          methodName: get_outputs
        allowFailure: true

  - name: gather-aws-live-state
    description: Collect live AWS resource state for comparison
    steps:
      - name: aws-inventory
        description: Run full AWS resource inventory
        task:
          type: model_method
          modelIdOrName: aws-inventory
          methodName: inventory_all
          inputs:
            includeS3: false
            includeStoppedEc2: true
            includeEbs: true
        allowFailure: true

      - name: aws-nat-gateways
        description: List NAT Gateways
        task:
          type: model_method
          modelIdOrName: aws-networking
          methodName: list_nat_gateways
        allowFailure: true

      - name: aws-load-balancers
        description: List load balancers
        task:
          type: model_method
          modelIdOrName: aws-networking
          methodName: list_load_balancers
        allowFailure: true

      - name: aws-elastic-ips
        description: List Elastic IPs
        task:
          type: model_method
          modelIdOrName: aws-networking
          methodName: list_elastic_ips
        allowFailure: true

version: 1
```

**Step 2: Commit**

```bash
git add aws/terraform-drift/workflows/terraform-drift.yaml
git commit -m "feat(aws/terraform-drift): add drift detection workflow"
```

---

### Task 3: Drift Report and Tests

**Files:**
- Create: `aws/terraform-drift/extensions/reports/drift_report.ts`
- Create: `aws/terraform-drift/extensions/reports/drift_report_test.ts`

**Step 1: Create the drift report**

Create `aws/terraform-drift/extensions/reports/drift_report.ts`:

```typescript
// Terraform AWS Drift Detection Report
// SPDX-License-Identifier: Apache-2.0

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

interface WorkflowReportContext {
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: string;
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: {
    info: (msg: string, props: Record<string, unknown>) => void;
  };
}

// =============================================================================
// Types
// =============================================================================

interface TfResource {
  address: string;
  mode: string;
  type: string;
  name: string;
  providerName: string;
  values: Record<string, unknown>;
  dependsOn: string[];
}

interface DriftFinding {
  tfAddress: string;
  tfType: string;
  resourceId: string;
  status: "missing_in_aws" | "field_drift";
  fields?: Array<{
    field: string;
    terraform: unknown;
    aws: unknown;
  }>;
}

interface AwsEc2Instance {
  instanceId: string;
  instanceType: string;
  state: string;
  tags: Record<string, string>;
}

interface AwsNatGateway {
  natGatewayId: string;
  state: string;
  vpcId: string;
  subnetId: string;
  tags: Record<string, string>;
}

interface AwsLoadBalancer {
  arn: string;
  name: string;
  type: string;
  scheme: string;
  vpcId: string;
  state: string;
}

interface AwsElasticIp {
  allocationId: string;
  publicIp: string;
  isAttached: boolean;
  tags: Record<string, string>;
}

// =============================================================================
// Report
// =============================================================================

export const report = {
  name: "@webframp/terraform-drift-report",
  description:
    "Compares Terraform state against live AWS resources to identify configuration drift",
  scope: "workflow" as const,
  labels: ["aws", "terraform", "drift", "compliance"],

  execute: async (context: WorkflowReportContext) => {
    const findings: DriftFinding[] = [];
    const sections: string[] = [];
    const summary = {
      timestamp: new Date().toISOString(),
      workflowName: context.workflowName,
      totalTfResources: 0,
      comparedResources: 0,
      driftedResources: 0,
      missingInAws: 0,
      fieldDrifts: 0,
      unsupportedTypes: 0,
    };

    // =========================================================================
    // Data helpers (same pattern as cost-audit report)
    // =========================================================================

    async function getData(
      modelType: string,
      modelId: string,
      dataName: string,
      version: number,
    ): Promise<Record<string, unknown> | null> {
      try {
        const dataPath =
          `${context.repoDir}/.swamp/data/${modelType}/${modelId}/${dataName}/${version}/raw`;
        const content = await Deno.readTextFile(dataPath);
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    function findStepHandles(
      modelName: string,
      methodName: string,
    ): Array<{ modelType: string; modelId: string; handle: DataHandle }> {
      const results: Array<
        { modelType: string; modelId: string; handle: DataHandle }
      > = [];
      for (const step of context.stepExecutions) {
        if (step.modelName === modelName && step.methodName === methodName) {
          for (const handle of step.dataHandles) {
            if (!handle.name.startsWith("report-")) {
              results.push({
                modelType: step.modelType,
                modelId: step.modelId,
                handle,
              });
            }
          }
        }
      }
      return results;
    }

    async function getStepData(
      modelName: string,
      methodName: string,
    ): Promise<Record<string, unknown> | null> {
      const handles = findStepHandles(modelName, methodName);
      if (handles.length === 0) return null;
      const h = handles[0];
      return await getData(
        h.modelType,
        h.modelId,
        h.handle.name,
        h.handle.version,
      );
    }

    // Also load individual tf_resource data handles written by read_state
    async function getTfResources(
      modelName: string,
    ): Promise<TfResource[]> {
      const handles = findStepHandles(modelName, "read_state");
      const resources: TfResource[] = [];
      for (const h of handles) {
        const data = await getData(
          h.modelType,
          h.modelId,
          h.handle.name,
          h.handle.version,
        );
        if (data && typeof data === "object" && "address" in data) {
          resources.push(data as unknown as TfResource);
        }
      }
      return resources;
    }

    // =========================================================================
    // Load data
    // =========================================================================

    // Terraform state
    const tfResources = await getTfResources("tf-infra");
    const tfInventoryData = await getStepData("tf-infra", "list_resources");

    // AWS live state
    const awsInventoryData = await getStepData(
      "aws-inventory",
      "inventory_all",
    );
    const awsNatData = await getStepData(
      "aws-networking",
      "list_nat_gateways",
    );
    const awsLbData = await getStepData(
      "aws-networking",
      "list_load_balancers",
    );
    const awsEipData = await getStepData(
      "aws-networking",
      "list_elastic_ips",
    );

    // Build lookup maps from AWS data
    const awsEc2Map = new Map<string, AwsEc2Instance>();
    if (awsInventoryData) {
      const resources = awsInventoryData.resources as
        | Record<string, unknown>
        | undefined;
      if (resources?.ec2) {
        for (const inst of resources.ec2 as AwsEc2Instance[]) {
          awsEc2Map.set(inst.instanceId, inst);
        }
      }
    }

    const awsNatMap = new Map<string, AwsNatGateway>();
    if (awsNatData) {
      for (const gw of (awsNatData.data ?? []) as AwsNatGateway[]) {
        awsNatMap.set(gw.natGatewayId, gw);
      }
    }

    const awsLbMap = new Map<string, AwsLoadBalancer>();
    if (awsLbData) {
      for (const lb of (awsLbData.data ?? []) as AwsLoadBalancer[]) {
        awsLbMap.set(lb.arn, lb);
      }
    }

    const awsEipMap = new Map<string, AwsElasticIp>();
    if (awsEipData) {
      for (const eip of (awsEipData.data ?? []) as AwsElasticIp[]) {
        awsEipMap.set(eip.allocationId, eip);
      }
    }

    // =========================================================================
    // Compare: TF declared vs AWS actual
    // =========================================================================

    // Filter to managed resources with AWS provider
    const managedTfResources = tfResources.filter(
      (r) =>
        r.mode === "managed" &&
        r.providerName.includes("hashicorp/aws"),
    );

    summary.totalTfResources = managedTfResources.length;

    const supportedTypes = new Set([
      "aws_instance",
      "aws_nat_gateway",
      "aws_lb",
      "aws_eip",
    ]);

    for (const tfr of managedTfResources) {
      if (!supportedTypes.has(tfr.type)) {
        summary.unsupportedTypes++;
        continue;
      }

      summary.comparedResources++;

      if (tfr.type === "aws_instance") {
        const awsId = tfr.values.id as string | undefined;
        if (!awsId) continue;
        const aws = awsEc2Map.get(awsId);
        if (!aws) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsId,
            status: "missing_in_aws",
          });
          continue;
        }
        const drifts: DriftFinding["fields"] = [];
        if (
          tfr.values.instance_type &&
          tfr.values.instance_type !== aws.instanceType
        ) {
          drifts.push({
            field: "instance_type",
            terraform: tfr.values.instance_type,
            aws: aws.instanceType,
          });
        }
        compareTags(tfr, aws.tags, drifts);
        if (drifts.length > 0) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsId,
            status: "field_drift",
            fields: drifts,
          });
        }
      } else if (tfr.type === "aws_nat_gateway") {
        const awsId = tfr.values.id as string | undefined;
        if (!awsId) continue;
        const aws = awsNatMap.get(awsId);
        if (!aws) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsId,
            status: "missing_in_aws",
          });
          continue;
        }
        const drifts: DriftFinding["fields"] = [];
        if (
          tfr.values.subnet_id && tfr.values.subnet_id !== aws.subnetId
        ) {
          drifts.push({
            field: "subnet_id",
            terraform: tfr.values.subnet_id,
            aws: aws.subnetId,
          });
        }
        compareTags(tfr, aws.tags, drifts);
        if (drifts.length > 0) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsId,
            status: "field_drift",
            fields: drifts,
          });
        }
      } else if (tfr.type === "aws_lb") {
        const awsArn = tfr.values.arn as string | undefined;
        if (!awsArn) continue;
        const aws = awsLbMap.get(awsArn);
        if (!aws) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsArn,
            status: "missing_in_aws",
          });
          continue;
        }
        const drifts: DriftFinding["fields"] = [];
        if (tfr.values.name && tfr.values.name !== aws.name) {
          drifts.push({
            field: "name",
            terraform: tfr.values.name,
            aws: aws.name,
          });
        }
        // TF uses internal=true/false, AWS uses scheme="internal"/"internet-facing"
        const tfInternal = tfr.values.internal as boolean | undefined;
        if (tfInternal !== undefined) {
          const awsInternal = aws.scheme === "internal";
          if (tfInternal !== awsInternal) {
            drifts.push({
              field: "internal/scheme",
              terraform: tfInternal,
              aws: aws.scheme,
            });
          }
        }
        if (drifts.length > 0) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsArn,
            status: "field_drift",
            fields: drifts,
          });
        }
      } else if (tfr.type === "aws_eip") {
        const awsAllocId = tfr.values.allocation_id as string ??
          tfr.values.id as string | undefined;
        if (!awsAllocId) continue;
        const aws = awsEipMap.get(awsAllocId);
        if (!aws) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsAllocId,
            status: "missing_in_aws",
          });
          continue;
        }
        const drifts: DriftFinding["fields"] = [];
        if (
          tfr.values.public_ip && tfr.values.public_ip !== aws.publicIp
        ) {
          drifts.push({
            field: "public_ip",
            terraform: tfr.values.public_ip,
            aws: aws.publicIp,
          });
        }
        compareTags(tfr, aws.tags, drifts);
        if (drifts.length > 0) {
          findings.push({
            tfAddress: tfr.address,
            tfType: tfr.type,
            resourceId: awsAllocId,
            status: "field_drift",
            fields: drifts,
          });
        }
      }
    }

    // =========================================================================
    // Tag comparison helper
    // =========================================================================

    function compareTags(
      tfr: TfResource,
      awsTags: Record<string, string> | undefined,
      drifts: NonNullable<DriftFinding["fields"]>,
    ): void {
      const tfTags = tfr.values.tags as Record<string, string> | undefined;
      if (!tfTags || !awsTags) return;
      for (const [key, tfVal] of Object.entries(tfTags)) {
        if (awsTags[key] !== tfVal) {
          drifts.push({
            field: `tags.${key}`,
            terraform: tfVal,
            aws: awsTags[key] ?? "(missing)",
          });
        }
      }
    }

    // =========================================================================
    // Build report output
    // =========================================================================

    summary.missingInAws = findings.filter((f) =>
      f.status === "missing_in_aws"
    ).length;
    summary.fieldDrifts = findings.filter((f) => f.status === "field_drift")
      .length;
    summary.driftedResources = findings.length;

    // Header
    sections.push("# Terraform Drift Report\n");
    sections.push(`**Generated:** ${summary.timestamp}`);
    sections.push(`**Workflow:** ${context.workflowName}\n`);

    // Summary table
    sections.push("## Summary\n");
    sections.push("| Metric | Count |");
    sections.push("|--------|-------|");
    sections.push(
      `| Total TF-managed AWS resources | ${summary.totalTfResources} |`,
    );
    sections.push(
      `| Compared (supported types) | ${summary.comparedResources} |`,
    );
    sections.push(
      `| Skipped (unsupported types) | ${summary.unsupportedTypes} |`,
    );
    sections.push(
      `| Resources with drift | ${summary.driftedResources} |`,
    );
    sections.push(
      `| Missing in AWS | ${summary.missingInAws} |`,
    );
    sections.push(
      `| Field-level drift | ${summary.fieldDrifts} |\n`,
    );

    // Supported types
    sections.push("## Supported Resource Types\n");
    sections.push(
      "Drift detection compares: `aws_instance`, `aws_nat_gateway`, `aws_lb`, `aws_eip`.",
    );
    sections.push(
      "Other resource types are inventoried but not yet compared.\n",
    );

    if (findings.length === 0) {
      sections.push("## Result: No Drift Detected\n");
      sections.push(
        "All compared resources match between Terraform state and live AWS.\n",
      );
    } else {
      // Missing in AWS
      const missing = findings.filter((f) => f.status === "missing_in_aws");
      if (missing.length > 0) {
        sections.push("## Missing in AWS\n");
        sections.push(
          "Resources declared in Terraform state but not found in live AWS:\n",
        );
        sections.push("| TF Address | Type | Resource ID |");
        sections.push("|-----------|------|-------------|");
        for (const f of missing) {
          sections.push(`| \`${f.tfAddress}\` | ${f.tfType} | ${f.resourceId} |`);
        }
        sections.push("");
      }

      // Field drift
      const drifted = findings.filter((f) => f.status === "field_drift");
      if (drifted.length > 0) {
        sections.push("## Field-Level Drift\n");
        for (const f of drifted) {
          sections.push(`### \`${f.tfAddress}\` (${f.resourceId})\n`);
          sections.push("| Field | Terraform | AWS |");
          sections.push("|-------|-----------|-----|");
          for (const d of f.fields ?? []) {
            sections.push(
              `| ${d.field} | \`${JSON.stringify(d.terraform)}\` | \`${JSON.stringify(d.aws)}\` |`,
            );
          }
          sections.push("");
        }
      }
    }

    // TF inventory summary (if available)
    if (tfInventoryData) {
      const inv = tfInventoryData as {
        terraformVersion: string;
        resourceCount: number;
      };
      sections.push("## Terraform State Info\n");
      sections.push(`- **Terraform version:** ${inv.terraformVersion}`);
      sections.push(
        `- **Total resources in state:** ${inv.resourceCount}\n`,
      );
    }

    context.logger.info("Drift report complete", {
      total: summary.totalTfResources,
      compared: summary.comparedResources,
      drifted: summary.driftedResources,
    });

    return {
      markdown: sections.join("\n"),
      json: { summary, findings },
    };
  },
};
```

**Step 2: Create tests**

Create `aws/terraform-drift/extensions/reports/drift_report_test.ts`:

```typescript
// Terraform drift report tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
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
          arn: "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/test/abc",
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
            arn: "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/test/abc",
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
```

**Step 3: Run tests**

```bash
cd aws/terraform-drift
deno test --allow-env --allow-read --allow-write extensions/reports/
```

Expected: All 10 tests pass.

**Step 4: Run check, lint, fmt**

```bash
deno check extensions/reports/drift_report.ts
deno lint extensions/reports/
deno fmt --check extensions/reports/
```

Expected: All clean. If fmt reformats, run `deno fmt extensions/reports/` first.

**Step 5: Commit**

```bash
git add aws/terraform-drift/extensions/reports/drift_report.ts \
        aws/terraform-drift/extensions/reports/drift_report_test.ts
git commit -m "feat(aws/terraform-drift): add drift detection report with tests"
```

---

### Task 4: CI and README

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: Add CI jobs**

Add to `.github/workflows/ci.yml` following the pattern of other extensions:

```yaml
  terraform-drift-check:
    name: terraform-drift - ${{ matrix.task }}
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        task: [check, lint, fmt]
    defaults:
      run:
        working-directory: aws/terraform-drift
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: deno ${{ matrix.task }}
        run: |
          if [ "${{ matrix.task }}" = "fmt" ]; then
            deno fmt --check extensions/reports/
          elif [ "${{ matrix.task }}" = "lint" ]; then
            deno lint extensions/reports/
          else
            deno check extensions/reports/drift_report.ts
          fi

  terraform-drift-test:
    name: terraform-drift - test
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: aws/terraform-drift
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: deno test
        run: deno test --allow-env --allow-read --allow-write extensions/reports/
```

**Step 2: Add to README**

Add a row to the Workflow+Report Extensions table (or create one if needed):

```markdown
| [`@webframp/aws/terraform-drift`](aws/terraform-drift/) | Terraform drift detection — compares TF state against live AWS resources | `@webframp/terraform`, `@webframp/aws/inventory`, `@webframp/aws/networking` |
```

Add to the Installation section:
```bash
swamp extension pull @webframp/aws/terraform-drift
```

Add a Usage section:
```markdown
### Terraform drift detection

```bash
swamp extension pull @webframp/aws/terraform-drift

# Create required model instances
swamp model create @webframp/terraform tf-infra \
  --global-arg workDir=/path/to/terraform/repo
swamp model create @webframp/aws/inventory aws-inventory \
  --global-arg region=us-east-1
swamp model create @webframp/aws/networking aws-networking \
  --global-arg region=us-east-1

# Run drift detection
swamp workflow run @webframp/terraform-drift
```

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci+docs: add terraform-drift extension to CI and README"
```
