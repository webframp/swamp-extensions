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

    summary.missingInAws =
      findings.filter((f) => f.status === "missing_in_aws").length;
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
          sections.push(
            `| \`${f.tfAddress}\` | ${f.tfType} | ${f.resourceId} |`,
          );
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
              `| ${d.field} | \`${JSON.stringify(d.terraform)}\` | \`${
                JSON.stringify(d.aws)
              }\` |`,
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
