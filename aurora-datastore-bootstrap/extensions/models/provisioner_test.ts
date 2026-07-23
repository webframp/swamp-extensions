import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./provisioner.ts";

type CommandHandler = (
  cmd: string,
  args: string[],
) => { stdout: string; success: boolean };

function withMockedCommand<T>(
  handler: CommandHandler,
  fn: () => Promise<T>,
): Promise<T> {
  const OriginalCommand = Deno.Command;
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, options: Record<string, unknown>) {
      this.#cmd = cmd;
      this.#args = (options?.args as string[]) ?? [];
    }
    output(): Promise<{
      success: boolean;
      code: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }> {
      const result = handler(this.#cmd, this.#args);
      const encoder = new TextEncoder();
      return Promise.resolve({
        success: result.success,
        code: result.success ? 0 : 1,
        stdout: encoder.encode(result.stdout),
        stderr: result.success
          ? new Uint8Array()
          : encoder.encode(result.stdout),
      });
    }
  };
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (Deno as any).Command = OriginalCommand;
  });
}

function createMockContext(globalArgs: {
  region: string;
  cluster_identifier: string;
  instance_identifier: string;
  master_username: string;
  master_password: string;
  database_name: string;
  vpc_id?: string;
  subnet_ids?: string;
  security_group_name: string;
  subnet_group_name: string;
  policy_name: string;
  min_acu: number;
  max_acu: number;
}) {
  const written: Array<{
    specName: string;
    name: string;
    data: Record<string, unknown>;
  }> = [];
  return {
    context: {
      globalArgs,
      writeResource: (
        specName: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ specName, name, data });
        return Promise.resolve({ name });
      },
    },
    written,
  };
}

const DEFAULT_ARGS = {
  region: "us-east-1",
  cluster_identifier: "test-cluster",
  instance_identifier: "test-writer",
  master_username: "swamp",
  master_password: "testpass123",
  database_name: "swamp",
  security_group_name: "test-sg",
  subnet_group_name: "test-subnets",
  policy_name: "TestPolicy",
  min_acu: 0.5,
  max_acu: 8,
};

Deno.test("model exports correct type and version", () => {
  assertEquals(model.type, "@webframp/aurora-datastore-bootstrap/provisioner");
  assertEquals(model.version, "2026.07.22.1");
});

Deno.test("model has provision method", () => {
  assertEquals(typeof model.methods.provision.execute, "function");
});

Deno.test("globalArguments defaults are correct", () => {
  const parsed = model.globalArguments.parse({
    master_password: "testpass123",
  });
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.cluster_identifier, "swamp-datastore");
  assertEquals(parsed.instance_identifier, "swamp-datastore-writer");
  assertEquals(parsed.master_username, "swamp");
  assertEquals(parsed.database_name, "swamp");
  assertEquals(parsed.min_acu, 0.5);
  assertEquals(parsed.max_acu, 8);
});

Deno.test("globalArguments requires master_password", () => {
  const result = model.globalArguments.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("globalArguments validates cluster_identifier pattern", () => {
  const result = model.globalArguments.safeParse({
    master_password: "test1234",
    cluster_identifier: "INVALID",
  });
  assertEquals(result.success, false);
});

Deno.test("provision creates all resources when none exist", async () => {
  const { context, written } = createMockContext(DEFAULT_ARGS);

  let clusterCreated = false;

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    // VPC
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-test", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }

    // Subnets
    if (sub === "ec2 describe-subnets") {
      return {
        success: true,
        stdout: JSON.stringify({
          Subnets: [{ SubnetId: "subnet-a" }, { SubnetId: "subnet-b" }],
        }),
      };
    }

    // Security groups (not found)
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({ SecurityGroups: [] }),
      };
    }
    if (sub === "ec2 create-security-group") {
      return {
        success: true,
        stdout: JSON.stringify({ GroupId: "sg-new" }),
      };
    }
    if (
      sub === "ec2 authorize-security-group-ingress" ||
      sub === "ec2 create-tags"
    ) {
      return { success: true, stdout: "{}" };
    }

    // DB subnet group (not found)
    if (sub === "rds describe-db-subnet-groups") {
      return { success: false, stdout: "DBSubnetGroupNotFoundFault" };
    }
    if (sub === "rds create-db-subnet-group") {
      return { success: true, stdout: "{}" };
    }

    // Cluster (not found, then available after create)
    if (sub === "rds describe-db-clusters") {
      if (clusterCreated) {
        return {
          success: true,
          stdout: JSON.stringify({
            DBClusters: [
              {
                DBClusterIdentifier: "test-cluster",
                DBClusterArn: "arn:aws:rds:us-east-1:123:cluster:test-cluster",
                Endpoint:
                  "test-cluster.cluster-xxx.us-east-1.rds.amazonaws.com",
                Port: 5432,
                Status: "available",
              },
            ],
          }),
        };
      }
      return { success: false, stdout: "DBClusterNotFoundFault" };
    }

    if (sub === "rds create-db-cluster") {
      clusterCreated = true;
      return { success: true, stdout: "{}" };
    }
    if (sub === "rds create-db-instance") {
      return { success: true, stdout: "{}" };
    }

    // STS
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "123" }) };
    }

    // IAM (not found)
    if (sub === "iam get-policy") {
      return { success: false, stdout: "NoSuchEntity" };
    }
    if (sub === "iam create-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::123:policy/TestPolicy" },
        }),
      };
    }

    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    const result = await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(result.dataHandles.length, 1);
    assertEquals(written[0]!.data.clusterCreated, true);
    assertEquals(written[0]!.data.securityGroupCreated, true);
    assertEquals(written[0]!.data.subnetGroupCreated, true);
    assertEquals(written[0]!.data.policyCreated, true);
    assertEquals(written[0]!.data.clusterPort, 5432);
    assertEquals(
      written[0]!.data.connectionString,
      "postgresql://swamp:testpass123@test-cluster.cluster-xxx.us-east-1.rds.amazonaws.com:5432/swamp",
    );
  });
});

Deno.test("provision reuses existing resources", async () => {
  const { context, written } = createMockContext({
    ...DEFAULT_ARGS,
    vpc_id: "vpc-exist",
    subnet_ids: "subnet-1,subnet-2",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-exist", CidrBlock: "172.16.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-exist" }],
        }),
      };
    }
    if (sub === "rds describe-db-subnet-groups") {
      return { success: true, stdout: JSON.stringify({}) };
    }
    if (sub === "rds describe-db-clusters") {
      return {
        success: true,
        stdout: JSON.stringify({
          DBClusters: [
            {
              DBClusterIdentifier: "test-cluster",
              DBClusterArn: "arn:aws:rds:us-east-1:456:cluster:test-cluster",
              Endpoint: "existing.rds.amazonaws.com",
              Port: 5432,
              Status: "available",
            },
          ],
        }),
      };
    }
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "456" }) };
    }
    if (sub === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::456:policy/TestPolicy" },
        }),
      };
    }
    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    assertEquals(written[0]!.data.clusterCreated, false);
    assertEquals(written[0]!.data.securityGroupCreated, false);
    assertEquals(written[0]!.data.subnetGroupCreated, false);
    assertEquals(written[0]!.data.policyCreated, false);
  });
});

Deno.test("provision throws when fewer than 2 subnets available", async () => {
  const { context } = createMockContext(DEFAULT_ARGS);

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-x", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-subnets") {
      return {
        success: true,
        stdout: JSON.stringify({ Subnets: [{ SubnetId: "subnet-only-one" }] }),
      };
    }
    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await assertRejects(
      () =>
        model.methods.provision.execute(
          {} as Record<string, never>,
          context,
        ),
      Error,
      "Need at least 2 subnets",
    );
  });
});

Deno.test("provision encodes password in connection string", async () => {
  const { context, written } = createMockContext({
    ...DEFAULT_ARGS,
    master_password: "p@ss/w0rd&special=chars",
    vpc_id: "vpc-x",
    subnet_ids: "subnet-a,subnet-b",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-x", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-x" }],
        }),
      };
    }
    if (sub === "rds describe-db-subnet-groups") {
      return { success: true, stdout: "{}" };
    }
    if (sub === "rds describe-db-clusters") {
      return {
        success: true,
        stdout: JSON.stringify({
          DBClusters: [
            {
              DBClusterArn: "arn:aws:rds:us-east-1:789:cluster:test-cluster",
              Endpoint: "host.rds.amazonaws.com",
              Port: 5432,
              Status: "available",
            },
          ],
        }),
      };
    }
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "789" }) };
    }
    if (sub === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::789:policy/TestPolicy" },
        }),
      };
    }
    return { success: true, stdout: "{}" };
  };

  await withMockedCommand(handler, async () => {
    await model.methods.provision.execute(
      {} as Record<string, never>,
      context,
    );
    const connStr = written[0]!.data.connectionString as string;
    assertEquals(connStr.includes("p%40ss%2Fw0rd%26special%3Dchars"), true);
    assertEquals(connStr.startsWith("postgresql://swamp:"), true);
    assertEquals(connStr.endsWith(":5432/swamp"), true);
  });
});
