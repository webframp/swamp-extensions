/**
 * GitLab datastore bootstrap provisioner.
 *
 * Validates access to a GitLab project, optionally creates a scoped project
 * access token for the datastore, and produces the configuration needed by
 * @webframp/gitlab-datastore.
 *
 * Unlike the AWS bootstraps, this provisioner requires no cloud infrastructure —
 * just a GitLab project with API access. It's a zero-cost PoC path for teams
 * already on GitLab.
 *
 * @module
 */
import { z } from "npm:zod@4.4.3";

const GlobalArgsSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      "GitLab project ID (numeric) or URL-encoded path (e.g., 'mygroup/myproject')",
    ),
  base_url: z
    .string()
    .url()
    .default("https://gitlab.com")
    .describe("GitLab instance base URL"),
  token: z
    .string()
    .min(1)
    .describe(
      "GitLab personal access token with api scope (used to validate and optionally create project token)",
    ),
  username: z
    .string()
    .optional()
    .describe("GitLab username (defaults to token owner)"),
  state_prefix: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("swamp")
    .describe("Prefix for Terraform state names to namespace swamp data"),
  create_project_token: z
    .boolean()
    .default(false)
    .describe(
      "Create a dedicated project access token for the datastore (requires Maintainer role)",
    ),
  project_token_name: z
    .string()
    .default("swamp-datastore")
    .describe("Name for the project access token if created"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ProvisionResultSchema = z.object({
  projectId: z.string().describe("GitLab project ID used"),
  projectName: z
    .string()
    .describe("GitLab project name (from API validation)"),
  projectUrl: z.string().describe("GitLab project web URL"),
  baseUrl: z.string().describe("GitLab instance URL"),
  statePrefix: z.string().describe("State prefix for namespace"),
  tokenType: z
    .string()
    .describe("Token type: 'provided' or 'project_access_token'"),
  projectTokenCreated: z
    .boolean()
    .describe("Whether a new project access token was created"),
  datastoreConfig: z
    .string()
    .describe("JSON config for swamp datastore setup command"),
  validatedAt: z.string().describe("ISO 8601 timestamp of validation"),
  durationMs: z.number().describe("Total provisioning duration in ms"),
});

/** Make a GitLab API request. */
async function gitlabApi(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: string } = {},
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `${baseUrl}/api/v4${path}`;
  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "PRIVATE-TOKEN": token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body,
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  return { ok: resp.ok, status: resp.status, data };
}

/** Validate that the project exists and token has access. */
async function validateProject(
  projectId: string,
  baseUrl: string,
  token: string,
): Promise<{ name: string; webUrl: string }> {
  const encodedId = encodeURIComponent(projectId);
  const { ok, status, data } = await gitlabApi(
    baseUrl,
    `/projects/${encodedId}`,
    token,
  );
  if (!ok) {
    if (status === 401) {
      throw new Error("GitLab token is invalid or expired");
    }
    if (status === 404) {
      throw new Error(
        `GitLab project '${projectId}' not found or token lacks access`,
      );
    }
    throw new Error(
      `GitLab API error ${status}: ${JSON.stringify(data)}`,
    );
  }
  return {
    name: (data as { name?: string }).name ?? "unknown",
    webUrl: (data as { web_url?: string }).web_url ?? "",
  };
}

/** Verify that the Terraform state API is accessible for this project. */
async function verifyStateAccess(
  projectId: string,
  baseUrl: string,
  token: string,
  statePrefix: string,
): Promise<void> {
  const encodedId = encodeURIComponent(projectId);
  // List terraform states — a 200 or 404 (no states yet) both mean access works
  const { ok, status } = await gitlabApi(
    baseUrl,
    `/projects/${encodedId}/terraform/state/${statePrefix}-healthcheck`,
    token,
  );
  // 200 = state exists, 404 = no state yet (both fine), 403 = no access
  if (!ok && status !== 404) {
    if (status === 403) {
      throw new Error(
        "Token lacks access to Terraform state API — needs api scope and at least Developer role",
      );
    }
    throw new Error(
      `Terraform state API returned unexpected status ${status}`,
    );
  }
}

/** Create a project access token with api scope. */
async function createProjectToken(
  projectId: string,
  baseUrl: string,
  token: string,
  tokenName: string,
): Promise<{ token: string; id: number }> {
  const encodedId = encodeURIComponent(projectId);
  // Token expires in 1 year
  const expiresAt = new Date(
    Date.now() + 365 * 24 * 60 * 60 * 1000,
  ).toISOString().split("T")[0];

  const { ok, status, data } = await gitlabApi(
    baseUrl,
    `/projects/${encodedId}/access_tokens`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        name: tokenName,
        scopes: ["api"],
        access_level: 30, // Developer
        expires_at: expiresAt,
      }),
    },
  );

  if (!ok) {
    if (status === 401 || status === 403) {
      throw new Error(
        "Cannot create project access token — requires Maintainer role on the project",
      );
    }
    throw new Error(
      `Failed to create project access token: ${status} ${
        JSON.stringify(data)
      }`,
    );
  }

  const newToken = (data as { token?: string }).token;
  const tokenId = (data as { id?: number }).id;
  if (!newToken || !tokenId) {
    throw new Error(
      "Project access token created but token value not returned",
    );
  }
  return { token: newToken, id: tokenId };
}

/** Provisioner model definition. */
export const model = {
  type: "@webframp/gitlab-datastore-bootstrap/provisioner",
  version: "2026.07.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "GitLab project validation and datastore configuration for swamp.",
      schema: ProvisionResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    provision: {
      description:
        "Validate GitLab project access, optionally create a project access token, and produce @webframp/gitlab-datastore configuration.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const {
          project_id,
          base_url,
          token,
          username,
          state_prefix,
          create_project_token,
          project_token_name,
        } = context.globalArgs;
        const startMs = Date.now();

        // 1. Validate project access
        const { name: projectName, webUrl: projectUrl } = await validateProject(
          project_id,
          base_url,
          token,
        );

        // 2. Verify Terraform state API access
        await verifyStateAccess(project_id, base_url, token, state_prefix);

        // 3. Optionally create a project access token
        let activeToken = token;
        let tokenType = "provided";
        let projectTokenCreated = false;

        if (create_project_token) {
          const result = await createProjectToken(
            project_id,
            base_url,
            token,
            project_token_name,
          );
          activeToken = result.token;
          tokenType = "project_access_token";
          projectTokenCreated = true;
        }

        // 4. Build datastore config
        const config: Record<string, string> = {
          projectId: project_id,
          baseUrl: base_url,
          token: activeToken,
          statePrefix: state_prefix,
        };
        if (username) config.username = username;

        const datastoreConfig = JSON.stringify(config);

        const durationMs = Date.now() - startMs;

        // 5. Write result
        const handle = await context.writeResource("state", "main", {
          projectId: project_id,
          projectName,
          projectUrl,
          baseUrl: base_url,
          statePrefix: state_prefix,
          tokenType,
          projectTokenCreated,
          datastoreConfig,
          validatedAt: new Date().toISOString(),
          durationMs,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
