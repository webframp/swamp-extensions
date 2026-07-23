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
  cache_name: string;
  vpc_id?: string;
  subnet_ids?: string;
  security_group_name: string;
  policy_name: string;
  key_prefix: string;
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

Deno.test("model exports correct type and version", () => {
  assertEquals(
    model.type,
    "@webframp/elasticache-datastore-bootstrap/provisioner",
  );
  assertEquals(model.version, "2026.07.23.1");
});

Deno.test("model has provision method", () => {
  assertEquals(typeof model.methods.provision.execute, "function");
});

Deno.test("globalArguments defaults are correct", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.region, "us-east-1");
  assertEquals(parsed.cache_name, "swamp-valkey");
  assertEquals(parsed.security_group_name, "swamp-valkey-access");
  assertEquals(parsed.policy_name, "SwampValkeyDatastorePolicy");
  assertEquals(parsed.key_prefix, "swamp");
  assertEquals(parsed.vpc_id, undefined);
  assertEquals(parsed.subnet_ids, undefined);
});

Deno.test("globalArguments validates cache_name pattern", () => {
  const result = model.globalArguments.safeParse({ cache_name: "123invalid" });
  assertEquals(result.success, false);
});

Deno.test("provision creates all resources when none exist", async () => {
  const { context, written } = createMockContext({
    region: "us-east-1",
    cache_name: "test-cache",
    security_group_name: "test-sg",
    policy_name: "TestPolicy",
    key_prefix: "swamp",
  });

  let cacheCreated = false;

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    // VPC lookups (default VPC and CIDR)
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-abc123", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }

    // Subnets
    if (sub === "ec2 describe-subnets") {
      return {
        success: true,
        stdout: JSON.stringify({
          Subnets: [
            { SubnetId: "subnet-aaa" },
            { SubnetId: "subnet-bbb" },
          ],
        }),
      };
    }

    // Security group lookup (not found)
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({ SecurityGroups: [] }),
      };
    }

    // Create security group
    if (sub === "ec2 create-security-group") {
      return {
        success: true,
        stdout: JSON.stringify({ GroupId: "sg-12345" }),
      };
    }

    // Authorize ingress
    if (sub === "ec2 authorize-security-group-ingress") {
      return { success: true, stdout: "{}" };
    }

    // Create tags
    if (sub === "ec2 create-tags") {
      return { success: true, stdout: "{}" };
    }

    // Describe serverless cache (not found then available)
    if (sub === "elasticache describe-serverless-caches") {
      if (cacheCreated) {
        return {
          success: true,
          stdout: JSON.stringify({
            ServerlessCaches: [
              {
                ServerlessCacheName: "test-cache",
                ARN:
                  "arn:aws:elasticache:us-east-1:123456789012:serverlesscache:test-cache",
                Status: "available",
                Endpoint: {
                  Address: "test-cache.xxx.cache.amazonaws.com",
                  Port: 6379,
                },
              },
            ],
          }),
        };
      }
      return {
        success: false,
        stdout: "ServerlessCacheNotFoundFault",
      };
    }

    // Create serverless cache
    if (sub === "elasticache create-serverless-cache") {
      cacheCreated = true;
      return {
        success: true,
        stdout: JSON.stringify({
          ServerlessCache: {
            ServerlessCacheName: "test-cache",
            Status: "creating",
          },
        }),
      };
    }

    // STS
    if (sub === "sts get-caller-identity") {
      return {
        success: true,
        stdout: JSON.stringify({ Account: "123456789012" }),
      };
    }

    // IAM get-policy (not found)
    if (sub === "iam get-policy") {
      return { success: false, stdout: "NoSuchEntity" };
    }

    // IAM create-policy
    if (sub === "iam create-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::123456789012:policy/TestPolicy" },
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
    assertEquals(written.length, 1);
    assertEquals(written[0]!.data.cacheName, "test-cache");
    assertEquals(written[0]!.data.cacheCreated, true);
    assertEquals(written[0]!.data.securityGroupId, "sg-12345");
    assertEquals(written[0]!.data.securityGroupCreated, true);
    assertEquals(written[0]!.data.policyCreated, true);
    assertEquals(
      written[0]!.data.cacheEndpoint,
      "rediss://test-cache.xxx.cache.amazonaws.com:6379",
    );
  });
});

Deno.test("provision reuses existing resources", async () => {
  const { context, written } = createMockContext({
    region: "us-west-2",
    cache_name: "existing-cache",
    vpc_id: "vpc-existing",
    subnet_ids: "subnet-x,subnet-y",
    security_group_name: "existing-sg",
    policy_name: "ExistingPolicy",
    key_prefix: "myprefix",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");

    // VPC CIDR (for SG ingress check, though SG already exists)
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-existing", CidrBlock: "172.16.0.0/16" }],
        }),
      };
    }

    // Security group exists
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-existing" }],
        }),
      };
    }

    // Cache exists and available
    if (sub === "elasticache describe-serverless-caches") {
      return {
        success: true,
        stdout: JSON.stringify({
          ServerlessCaches: [
            {
              ServerlessCacheName: "existing-cache",
              ARN:
                "arn:aws:elasticache:us-west-2:999:serverlesscache:existing-cache",
              Status: "available",
              SecurityGroupIds: ["sg-cache-original"],
              Endpoint: { Address: "existing.cache.amazonaws.com", Port: 6379 },
            },
          ],
        }),
      };
    }

    // STS
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "999" }) };
    }

    // IAM policy exists
    if (sub === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::999:policy/ExistingPolicy" },
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
    assertEquals(written[0]!.data.cacheCreated, false);
    assertEquals(written[0]!.data.securityGroupCreated, false);
    assertEquals(written[0]!.data.policyCreated, false);
    assertEquals(written[0]!.data.securityGroupId, "sg-cache-original");
  });
});

Deno.test("provision throws when no default VPC found", async () => {
  const { context } = createMockContext({
    region: "us-east-1",
    cache_name: "test",
    security_group_name: "sg",
    policy_name: "p",
    key_prefix: "s",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return { success: true, stdout: JSON.stringify({ Vpcs: [] }) };
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
      "No default VPC found",
    );
  });
});

Deno.test("provision builds correct datastoreConfig", async () => {
  const { context, written } = createMockContext({
    region: "eu-west-1",
    cache_name: "my-cache",
    vpc_id: "vpc-test",
    subnet_ids: "subnet-1",
    security_group_name: "sg",
    policy_name: "pol",
    key_prefix: "custom-prefix",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-test", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-xxx" }],
        }),
      };
    }
    if (sub === "elasticache describe-serverless-caches") {
      return {
        success: true,
        stdout: JSON.stringify({
          ServerlessCaches: [
            {
              ServerlessCacheName: "my-cache",
              ARN: "arn:aws:elasticache:eu-west-1:111:serverlesscache:my-cache",
              Status: "available",
              SecurityGroupIds: ["sg-xxx"],
              Endpoint: {
                Address: "my-cache.eu.cache.amazonaws.com",
                Port: 6379,
              },
            },
          ],
        }),
      };
    }
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "111" }) };
    }
    if (sub === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::111:policy/pol" },
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
    const config = JSON.parse(written[0]!.data.datastoreConfig as string);
    assertEquals(config.url, "rediss://my-cache.eu.cache.amazonaws.com:6379");
    assertEquals(config.prefix, "custom-prefix");
  });
});

Deno.test("provision waits when existing cache is in creating state", async () => {
  const { context, written } = createMockContext({
    region: "us-east-1",
    cache_name: "creating-cache",
    vpc_id: "vpc-test",
    subnet_ids: "subnet-1",
    security_group_name: "sg",
    policy_name: "pol",
    key_prefix: "swamp",
  });

  let describeCallCount = 0;

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-test", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-abc" }],
        }),
      };
    }
    if (sub === "elasticache describe-serverless-caches") {
      describeCallCount++;
      // First call: cache exists but in creating state
      // Second call (from waitForCacheAvailable): now available
      if (describeCallCount === 1) {
        return {
          success: true,
          stdout: JSON.stringify({
            ServerlessCaches: [
              {
                ServerlessCacheName: "creating-cache",
                ARN:
                  "arn:aws:elasticache:us-east-1:123:serverlesscache:creating-cache",
                Status: "creating",
                SecurityGroupIds: ["sg-abc"],
              },
            ],
          }),
        };
      }
      return {
        success: true,
        stdout: JSON.stringify({
          ServerlessCaches: [
            {
              ServerlessCacheName: "creating-cache",
              ARN:
                "arn:aws:elasticache:us-east-1:123:serverlesscache:creating-cache",
              Status: "available",
              SecurityGroupIds: ["sg-abc"],
              Endpoint: {
                Address: "creating-cache.xxx.cache.amazonaws.com",
                Port: 6379,
              },
            },
          ],
        }),
      };
    }
    if (sub === "sts get-caller-identity") {
      return { success: true, stdout: JSON.stringify({ Account: "123" }) };
    }
    if (sub === "iam get-policy") {
      return {
        success: true,
        stdout: JSON.stringify({
          Policy: { Arn: "arn:aws:iam::123:policy/pol" },
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
    assertEquals(written[0]!.data.cacheCreated, false);
    assertEquals(written[0]!.data.cacheStatus, "available");
    assertEquals(
      written[0]!.data.cacheEndpoint,
      "rediss://creating-cache.xxx.cache.amazonaws.com:6379",
    );
    // Waited for availability — should have polled at least twice
    assertEquals(describeCallCount >= 2, true);
  });
});

Deno.test("provision throws when cache has no ARN", async () => {
  const { context } = createMockContext({
    region: "us-east-1",
    cache_name: "no-arn-cache",
    vpc_id: "vpc-test",
    subnet_ids: "subnet-1",
    security_group_name: "sg",
    policy_name: "pol",
    key_prefix: "swamp",
  });

  const handler: CommandHandler = (_cmd, args) => {
    const sub = args.slice(0, 2).join(" ");
    if (sub === "ec2 describe-vpcs") {
      return {
        success: true,
        stdout: JSON.stringify({
          Vpcs: [{ VpcId: "vpc-test", CidrBlock: "10.0.0.0/16" }],
        }),
      };
    }
    if (sub === "ec2 describe-security-groups") {
      return {
        success: true,
        stdout: JSON.stringify({
          SecurityGroups: [{ GroupId: "sg-abc" }],
        }),
      };
    }
    if (sub === "elasticache describe-serverless-caches") {
      return {
        success: true,
        stdout: JSON.stringify({
          ServerlessCaches: [
            {
              ServerlessCacheName: "no-arn-cache",
              Status: "available",
              SecurityGroupIds: ["sg-abc"],
              Endpoint: { Address: "x.cache.amazonaws.com", Port: 6379 },
              // No ARN field
            },
          ],
        }),
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
      "returned no ARN",
    );
  });
});
