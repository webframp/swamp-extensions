/**
 * OCI container image build and push model.
 *
 * Builds images locally via docker/podman buildx, pushes to any
 * OCI-compliant registry, and inspects image metadata. Produces
 * typed, versioned output for each operation.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  command: z
    .string()
    .default("docker")
    .describe("Container CLI binary (docker, podman, nerdctl, buildah)"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

function isBuildah(cli: string): boolean {
  return cli === "buildah" || cli.endsWith("/buildah");
}

function sanitizeResourceName(tag: string): string {
  return tag.replace(/[/\\:@]/g, "_");
}

const BuildArgsSchema = z.object({
  contextPath: z.string().describe("Path to the build context directory"),
  dockerfile: z
    .string()
    .optional()
    .describe("Path to Dockerfile relative to context (default: Dockerfile)"),
  tag: z.string().min(1).describe(
    "Image tag (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest)",
  ),
  platform: z
    .string()
    .optional()
    .describe("Target platform (e.g. linux/arm64, linux/amd64)"),
  buildArgs: z
    .record(z.string(), z.string())
    .optional()
    .describe("Build-time variables"),
});

const PushArgsSchema = z.object({
  tag: z.string().min(1).describe("Image tag to push"),
});

const InspectArgsSchema = z.object({
  tag: z.string().min(1).describe("Image tag to inspect"),
});

const LoginArgsSchema = z.object({
  registry: z.string().describe(
    "Registry URL (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com)",
  ),
  username: z.string().default("AWS").describe("Registry username"),
  password: z.string().meta({ sensitive: true }).describe(
    "Registry password or token",
  ),
});

const BuildResultSchema = z.object({
  tag: z.string(),
  imageId: z.string(),
  platform: z.string().nullable(),
  contextPath: z.string(),
  dockerfile: z.string(),
  buildDurationMs: z.number(),
  builtAt: z.string(),
});

const PushResultSchema = z.object({
  tag: z.string(),
  digest: z.string(),
  size: z.number().nullable(),
  pushedAt: z.string(),
  pushDurationMs: z.number(),
});

const InspectResultSchema = z.object({
  tag: z.string(),
  id: z.string(),
  digest: z.string().nullable(),
  architecture: z.string(),
  os: z.string(),
  size: z.number(),
  created: z.string(),
  inspectedAt: z.string(),
});

async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; success: boolean; code: number }> {
  const command = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
    code: output.code,
  };
}

/** Container image model definition. */
export const model = {
  type: "@webframp/container-image",
  version: "2026.06.12.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    build: {
      description: "Container image build result",
      schema: BuildResultSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    push: {
      description: "Container image push result with digest",
      schema: PushResultSchema,
      lifetime: "30d",
      garbageCollection: 20,
    },
    inspect: {
      description: "Container image inspection metadata",
      schema: InspectResultSchema,
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  methods: {
    login: {
      description:
        "Authenticate to a container registry. Run before push for private registries.",
      arguments: LoginArgsSchema,
      execute: async (
        args: z.infer<typeof LoginArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (msg: string, ...a: unknown[]) => void };
        },
      ) => {
        const cli = context.globalArgs.command;

        const cmd = new Deno.Command(cli, {
          args: [
            "login",
            "--username",
            args.username,
            "--password-stdin",
            args.registry,
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const process = cmd.spawn();
        const writer = process.stdin.getWriter();
        await writer.write(new TextEncoder().encode(args.password));
        await writer.close();
        const output = await process.output();

        if (!output.success) {
          const stderr = new TextDecoder().decode(output.stderr);
          throw new Error(`Login failed: ${stderr}`);
        }

        context.logger.info("Authenticated to {registry}", {
          registry: args.registry,
        });
        return { dataHandles: [] };
      },
    },

    build: {
      description:
        "Build a container image from a Dockerfile. Supports multi-platform builds via buildx.",
      arguments: BuildArgsSchema,
      execute: async (
        args: z.infer<typeof BuildArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (msg: string, ...a: unknown[]) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const cli = context.globalArgs.command;
        const start = performance.now();

        const buildArgs: string[] = isBuildah(cli)
          ? ["build"]
          : ["buildx", "build"];
        if (args.platform) {
          buildArgs.push("--platform", args.platform);
        }
        if (args.dockerfile) {
          buildArgs.push("-f", args.dockerfile);
        }
        buildArgs.push("-t", args.tag);
        if (!isBuildah(cli)) {
          buildArgs.push("--load");
        }

        if (args.buildArgs) {
          for (const [k, v] of Object.entries(args.buildArgs)) {
            buildArgs.push("--build-arg", `${k}=${v}`);
          }
        }

        buildArgs.push("--", args.contextPath);

        context.logger.info("Building {tag} from {contextPath}", {
          tag: args.tag,
          contextPath: args.contextPath,
        });

        const result = await runCommand(cli, buildArgs);
        const buildDurationMs = Math.round(performance.now() - start);

        if (!result.success) {
          throw new Error(
            `Build failed (exit ${result.code}): ${result.stderr}`,
          );
        }

        const inspectArgs = isBuildah(cli)
          ? [
            "inspect",
            "--type=image",
            "--format",
            "{{.FromImageID}}",
            args.tag,
          ]
          : ["image", "inspect", args.tag, "--format", "{{.Id}}"];
        const inspect = await runCommand(cli, inspectArgs);
        const imageId = inspect.stdout.trim();

        const data = {
          tag: args.tag,
          imageId,
          platform: args.platform ?? null,
          contextPath: args.contextPath,
          dockerfile: args.dockerfile ?? "Dockerfile",
          buildDurationMs,
          builtAt: new Date().toISOString(),
        };

        context.logger.info("Built {tag} in {buildDurationMs}ms", {
          tag: args.tag,
          buildDurationMs,
        });

        const handle = await context.writeResource(
          "build",
          sanitizeResourceName(args.tag),
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    push: {
      description:
        "Push a built image to its registry. Run login first for private registries.",
      arguments: PushArgsSchema,
      execute: async (
        args: z.infer<typeof PushArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (msg: string, ...a: unknown[]) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const cli = context.globalArgs.command;
        const start = performance.now();

        context.logger.info("Pushing {tag}", { tag: args.tag });

        const result = await runCommand(cli, ["push", args.tag]);
        const pushDurationMs = Math.round(performance.now() - start);

        if (!result.success) {
          throw new Error(
            `Push failed (exit ${result.code}): ${result.stderr}`,
          );
        }

        const digestArgs = isBuildah(cli)
          ? [
            "inspect",
            "--type=image",
            "--format",
            "{{.FromImageDigest}}",
            args.tag,
          ]
          : [
            "image",
            "inspect",
            args.tag,
            "--format",
            "{{index .RepoDigests 0}}",
          ];
        const digestResult = await runCommand(cli, digestArgs);
        const digestLine = digestResult.stdout.trim();
        const digest = digestLine.includes("@")
          ? digestLine.split("@")[1] ?? digestLine
          : digestLine;

        const sizeArgs = isBuildah(cli)
          ? ["inspect", "--type=image", "--format", "{{.Size}}", args.tag]
          : ["image", "inspect", args.tag, "--format", "{{.Size}}"];
        const sizeResult = await runCommand(cli, sizeArgs);
        const size = parseInt(sizeResult.stdout.trim(), 10) || null;

        const data = {
          tag: args.tag,
          digest,
          size,
          pushedAt: new Date().toISOString(),
          pushDurationMs,
        };

        context.logger.info("Pushed {tag} digest={digest}", {
          tag: args.tag,
          digest,
        });

        const handle = await context.writeResource(
          "push",
          sanitizeResourceName(args.tag),
          data,
        );
        return { dataHandles: [handle] };
      },
    },

    inspect: {
      description: "Inspect a local image and return its metadata.",
      arguments: InspectArgsSchema,
      execute: async (
        args: z.infer<typeof InspectArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const cli = context.globalArgs.command;

        const inspectArgs = isBuildah(cli)
          ? ["inspect", "--type=image", "--format", "{{json .}}", args.tag]
          : ["image", "inspect", args.tag, "--format", "{{json .}}"];
        const result = await runCommand(cli, inspectArgs);

        if (!result.success) {
          throw new Error(
            `Inspect failed (exit ${result.code}): ${result.stderr}`,
          );
        }

        if (!result.stdout.trim()) {
          throw new Error(`Inspect returned empty output for ${args.tag}`);
        }
        const raw = JSON.parse(result.stdout);

        const data = isBuildah(cli)
          ? {
            tag: args.tag,
            id: raw.FromImageID ?? "",
            digest: raw.FromImageDigest ?? null,
            architecture: raw.OCIv1?.architecture ?? "unknown",
            os: raw.OCIv1?.os ?? "unknown",
            size: raw.Size ?? 0,
            created: raw.OCIv1?.created ?? "",
            inspectedAt: new Date().toISOString(),
          }
          : {
            tag: args.tag,
            id: raw.Id ?? "",
            digest: (raw.RepoDigests?.[0]?.split("@")[1]) ?? null,
            architecture: raw.Architecture ?? "unknown",
            os: raw.Os ?? "unknown",
            size: raw.Size ?? 0,
            created: raw.Created ?? "",
            inspectedAt: new Date().toISOString(),
          };

        const handle = await context.writeResource(
          "inspect",
          sanitizeResourceName(args.tag),
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
