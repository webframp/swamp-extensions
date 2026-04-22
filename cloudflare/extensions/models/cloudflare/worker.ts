/**
 * Cloudflare Workers Management model for swamp.
 *
 * Provides methods to list, inspect, deploy, and delete Worker scripts,
 * manage Worker routes for zones, and toggle workers.dev subdomain access.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4";
import { cfApi, cfApiPaginated } from "./_lib/api.ts";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().meta({ sensitive: true }).describe(
    "Cloudflare API token with Workers read/write permissions",
  ),
  accountId: z.string().describe("Cloudflare account ID"),
});

const WorkerScriptSchema = z.object({
  id: z.string(),
  etag: z.string().optional(),
  created_on: z.string(),
  modified_on: z.string(),
  usage_model: z.string().optional(),
  handlers: z.array(z.string()).optional(),
  last_deployed_from: z.string().optional(),
});

const WorkerScriptListSchema = z.object({
  accountId: z.string(),
  scripts: z.array(WorkerScriptSchema),
  fetchedAt: z.string(),
});

const WorkerRouteSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  script: z.string().optional(),
});

const WorkerRouteListSchema = z.object({
  zoneId: z.string(),
  routes: z.array(WorkerRouteSchema),
  fetchedAt: z.string(),
});

const WorkerDeploymentSchema = z.object({
  scriptName: z.string(),
  deployedAt: z.string(),
  success: z.boolean(),
});

// =============================================================================
// Model Definition
// =============================================================================

/** Cloudflare Workers model definition with methods for script lifecycle, route management, and subdomain toggling. */
export const model = {
  type: "@webframp/cloudflare/worker",
  version: "2026.03.28.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "scripts": {
      description: "List of Worker scripts in the account",
      schema: WorkerScriptListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "script": {
      description: "Single Worker script metadata",
      schema: WorkerScriptSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "routes": {
      description: "Worker routes for a zone",
      schema: WorkerRouteListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "deployment": {
      description: "Worker deployment result",
      schema: WorkerDeploymentSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },

  files: {
    "source": {
      description: "Worker script source code",
      contentType: "application/javascript",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },

  methods: {
    list_scripts: {
      description: "List all Worker scripts in the account",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          globalArgs: { apiToken: string; accountId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, accountId } = context.globalArgs;

        const scripts = await cfApiPaginated<
          z.infer<typeof WorkerScriptSchema>
        >(
          apiToken,
          `/accounts/${accountId}/workers/scripts`,
        );

        const handle = await context.writeResource("scripts", "main", {
          accountId,
          scripts,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} Worker scripts", {
          count: scripts.length,
        });
        return { dataHandles: [handle] };
      },
    },

    get_script: {
      description: "Get Worker script metadata and source code",
      arguments: z.object({
        scriptName: z.string().describe("Worker script name"),
      }),
      execute: async (
        args: { scriptName: string },
        context: {
          globalArgs: { apiToken: string; accountId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          createFileWriter: (
            spec: string,
            instance: string,
          ) => { writeText: (content: string) => Promise<{ name: string }> };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, accountId } = context.globalArgs;
        const handles = [];

        // Get metadata
        const metadata = await cfApi<z.infer<typeof WorkerScriptSchema>>(
          apiToken,
          "GET",
          `/accounts/${accountId}/workers/scripts/${args.scriptName}`,
        );
        handles.push(
          await context.writeResource("script", args.scriptName, metadata),
        );

        // Get source code
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${args.scriptName}/content`,
          {
            headers: { "Authorization": `Bearer ${apiToken}` },
          },
        );

        if (response.ok) {
          const source = await response.text();
          const writer = context.createFileWriter("source", args.scriptName);
          handles.push(await writer.writeText(source));
        }

        context.logger.info("Fetched Worker script {name}", {
          name: args.scriptName,
        });
        return { dataHandles: handles };
      },
    },

    deploy: {
      description: "Deploy a Worker script",
      arguments: z.object({
        scriptName: z.string().describe("Worker script name"),
        script: z.string().describe("JavaScript/TypeScript source code"),
        bindings: z.array(z.object({
          type: z.enum([
            "kv_namespace",
            "durable_object_namespace",
            "r2_bucket",
            "secret_text",
            "plain_text",
          ]),
          name: z.string(),
          value: z.string().optional(),
        })).optional().describe("Environment bindings"),
      }),
      execute: async (
        args: {
          scriptName: string;
          script: string;
          bindings?: Array<{ type: string; name: string; value?: string }>;
        },
        context: {
          globalArgs: { apiToken: string; accountId: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, accountId } = context.globalArgs;

        // Build multipart form data for ES module upload
        const formData = new FormData();

        // For ES modules, the part name must be the module filename
        // and content type must be application/javascript+module
        const moduleFilename = "index.js";
        formData.append(
          moduleFilename,
          new Blob([args.script], { type: "application/javascript+module" }),
          moduleFilename,
        );

        // Metadata must specify main_module matching the uploaded filename
        const metadata: { main_module: string; bindings?: unknown[] } = {
          main_module: moduleFilename,
        };
        if (args.bindings) {
          metadata.bindings = args.bindings;
        }
        formData.append(
          "metadata",
          new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        );

        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${args.scriptName}`,
          {
            method: "PUT",
            headers: { "Authorization": `Bearer ${apiToken}` },
            body: formData,
          },
        );

        const data = await response.json() as {
          success: boolean;
          errors?: Array<{ message: string }>;
        };

        if (!data.success) {
          const errorMsg = data.errors?.map((e) => e.message).join("; ") ??
            "Unknown error";
          throw new Error(`Worker deployment failed: ${errorMsg}`);
        }

        const handle = await context.writeResource(
          "deployment",
          args.scriptName,
          {
            scriptName: args.scriptName,
            deployedAt: new Date().toISOString(),
            success: true,
          },
        );

        context.logger.info("Deployed Worker script {name}", {
          name: args.scriptName,
        });
        return { dataHandles: [handle] };
      },
    },

    delete_script: {
      description: "Delete a Worker script",
      arguments: z.object({
        scriptName: z.string().describe("Worker script name to delete"),
      }),
      execute: async (
        args: { scriptName: string },
        context: {
          globalArgs: { apiToken: string; accountId: string };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, accountId } = context.globalArgs;

        await cfApi(
          apiToken,
          "DELETE",
          `/accounts/${accountId}/workers/scripts/${args.scriptName}`,
        );

        context.logger.info("Deleted Worker script {name}", {
          name: args.scriptName,
        });
        return { dataHandles: [] };
      },
    },

    list_routes: {
      description: "List Worker routes for a zone",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
      }),
      execute: async (
        args: { zoneId: string },
        context: {
          globalArgs: { apiToken: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken } = context.globalArgs;

        const routes = await cfApiPaginated<z.infer<typeof WorkerRouteSchema>>(
          apiToken,
          `/zones/${args.zoneId}/workers/routes`,
        );

        const handle = await context.writeResource("routes", args.zoneId, {
          zoneId: args.zoneId,
          routes,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Found {count} Worker routes", {
          count: routes.length,
        });
        return { dataHandles: [handle] };
      },
    },

    create_route: {
      description: "Create a Worker route",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
        pattern: z.string().describe("Route pattern (e.g., 'example.com/*')"),
        scriptName: z.string().describe("Worker script name to execute"),
      }),
      execute: async (
        args: { zoneId: string; pattern: string; scriptName: string },
        context: {
          globalArgs: { apiToken: string };
          writeResource: (
            spec: string,
            instance: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken } = context.globalArgs;

        await cfApi<z.infer<typeof WorkerRouteSchema>>(
          apiToken,
          "POST",
          `/zones/${args.zoneId}/workers/routes`,
          { pattern: args.pattern, script: args.scriptName },
        );

        // Refresh routes list
        const routes = await cfApiPaginated<z.infer<typeof WorkerRouteSchema>>(
          apiToken,
          `/zones/${args.zoneId}/workers/routes`,
        );

        const handle = await context.writeResource("routes", args.zoneId, {
          zoneId: args.zoneId,
          routes,
          fetchedAt: new Date().toISOString(),
        });

        context.logger.info("Created Worker route {pattern} -> {script}", {
          pattern: args.pattern,
          script: args.scriptName,
        });
        return { dataHandles: [handle] };
      },
    },

    delete_route: {
      description: "Delete a Worker route",
      arguments: z.object({
        zoneId: z.string().describe("Zone ID"),
        routeId: z.string().describe("Route ID to delete"),
      }),
      execute: async (
        args: { zoneId: string; routeId: string },
        context: {
          globalArgs: { apiToken: string };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken } = context.globalArgs;

        await cfApi(
          apiToken,
          "DELETE",
          `/zones/${args.zoneId}/workers/routes/${args.routeId}`,
        );

        context.logger.info("Deleted Worker route {routeId}", {
          routeId: args.routeId,
        });
        return { dataHandles: [] };
      },
    },

    toggle_subdomain: {
      description:
        "Enable or disable workers.dev subdomain for a Worker script",
      arguments: z.object({
        scriptName: z.string().describe("Worker script name"),
        enabled: z.boolean().describe(
          "Enable or disable workers.dev subdomain",
        ),
      }),
      execute: async (
        args: { scriptName: string; enabled: boolean },
        context: {
          globalArgs: { apiToken: string; accountId: string };
          logger: {
            info: (msg: string, props: Record<string, unknown>) => void;
          };
        },
      ) => {
        const { apiToken, accountId } = context.globalArgs;

        await cfApi(
          apiToken,
          "POST",
          `/accounts/${accountId}/workers/scripts/${args.scriptName}/subdomain`,
          { enabled: args.enabled },
        );

        const status = args.enabled ? "enabled" : "disabled";
        context.logger.info("Workers.dev subdomain {status} for {scriptName}", {
          status,
          scriptName: args.scriptName,
        });
        return { dataHandles: [] };
      },
    },
  },
};
