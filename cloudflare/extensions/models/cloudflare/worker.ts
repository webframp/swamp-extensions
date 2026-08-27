/**
 * Cloudflare Workers Management model for swamp.
 *
 * Provides methods to list, inspect, deploy, and delete Worker scripts,
 * manage Worker routes for zones, and toggle workers.dev subdomain access.
 *
 * @module
 */
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { z } from "npm:zod@4.4.3";
import { cfApi, cfApiPaginated } from "./_lib/api.ts";

const EXTENSION_NAME = "@webframp/cloudflare";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Cloudflare API token with Workers read/write permissions",
  ),
  accountId: z.string().min(1).describe("Cloudflare account ID"),
});

const WorkerScriptSchema = z.object({
  id: z.string(),
  etag: z.string().optional(),
  created_on: z.string(),
  modified_on: z.string(),
  usage_model: z.string().optional(),
  handlers: z.array(z.string()).optional(),
  last_deployed_from: z.string().optional(),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const WorkerScriptListSchema = z.object({
  accountId: z.string(),
  scripts: z.array(WorkerScriptSchema),
  fetchedAt: z.string(),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
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
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

const WorkerDeploymentSchema = z.object({
  scriptName: z.string(),
  deployedAt: z.string(),
  success: z.boolean(),
  fetchedAt: z.string().optional().describe(
    "ISO 8601 timestamp when data was fetched",
  ),
  durationMs: z.number().optional().describe(
    "Method execution duration in milliseconds",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data",
  ),
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Map a user-facing binding ({ type, name, value }) to the shape the
 * Cloudflare Workers script-upload API expects. Each binding type uses a
 * different field name for the binding's value:
 *
 *   plain_text / secret_text         → { type, name, text }
 *   kv_namespace                     → { type, name, namespace_id }
 *   r2_bucket                        → { type, name, bucket_name }
 *   durable_object_namespace         → { type, name, class_name }
 */
export function mapBinding(
  b: { type: string; name: string; value?: string },
): Record<string, unknown> {
  switch (b.type) {
    case "plain_text":
    case "secret_text":
      return { type: b.type, name: b.name, text: b.value };
    case "kv_namespace":
      return { type: b.type, name: b.name, namespace_id: b.value };
    case "r2_bucket":
      return { type: b.type, name: b.name, bucket_name: b.value };
    case "durable_object_namespace":
      return { type: b.type, name: b.name, class_name: b.value };
    default:
      // Forward unknown binding types unchanged for forward-compatibility
      return { type: b.type, name: b.name, value: b.value };
  }
}

// =============================================================================
// Model Definition
// =============================================================================

/** Cloudflare Workers model definition with methods for script lifecycle, route management, and subdomain toggling. */
export const model = {
  type: "@webframp/cloudflare/worker",
  version: "2026.08.26.3",
  globalArguments: GlobalArgsSchema,

  upgrades: [
    {
      toVersion: "2026.07.18.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.13.1",
      description: "No schema changes — fixed bindings mapping in deploy",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.21.2",
      description:
        "Wrap deploy/get_script request and non-JSON-response failures with " +
        "the script name and HTTP status; shared _lib/api.ts now wraps " +
        "Cloudflare API failures with the method/path/status",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.24.2",
      description: "No schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },

    {
      toVersion: "2026.08.24.3",

      description:
        "Added optional durationMs, collectedBy, and fetchedAt output metadata fields",

      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.25.1",
      description: "Label metadata update, no schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.1",
      description: "Fix missing upgrade description metadata",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.26.3",
      description:
        "No schema changes — restored inline npm:zod specifier for registry scoring; retained strict mode",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],

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
        const startMs = Date.now();
        const { apiToken, accountId } = context.globalArgs;

        const { results: scripts, truncated } = await cfApiPaginated<
          z.infer<typeof WorkerScriptSchema>
        >(
          apiToken,
          `/accounts/${accountId}/workers/scripts`,
        );

        if (truncated) {
          context.logger.info(
            "WARNING: Worker scripts truncated at {count} results (pagination cap reached)",
            { count: scripts.length },
          );
        }

        const handle = await context.writeResource("scripts", "main", {
          accountId,
          scripts,
          truncated,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        scriptName: z.string().min(1).describe("Worker script name"),
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
        const startMs = Date.now();
        const { apiToken, accountId } = context.globalArgs;
        const handles = [];

        // Get metadata
        const metadata = await cfApi<z.infer<typeof WorkerScriptSchema>>(
          apiToken,
          "GET",
          `/accounts/${accountId}/workers/scripts/${args.scriptName}`,
        );
        handles.push(
          await context.writeResource("script", args.scriptName, {
            ...metadata,
            fetchedAt: new Date().toISOString(),
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
          }),
        );

        // Get source code
        let response: Response;
        try {
          response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${args.scriptName}/content`,
            {
              headers: { "Authorization": `Bearer ${apiToken}` },
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Worker script content request failed for ${args.scriptName}: ${message}`,
            { cause: err },
          );
        }

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
        scriptName: z.string().min(1).describe("Worker script name"),
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
        const startMs = Date.now();
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
          metadata.bindings = args.bindings.map((b) => mapBinding(b));
        }
        formData.append(
          "metadata",
          new Blob([JSON.stringify(metadata)], { type: "application/json" }),
        );

        let response: Response;
        try {
          response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${args.scriptName}`,
            {
              method: "PUT",
              headers: { "Authorization": `Bearer ${apiToken}` },
              body: formData,
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Worker deployment request failed for script ${args.scriptName}: ${message}`,
            { cause: err },
          );
        }

        let data: { success: boolean; errors?: Array<{ message: string }> };
        try {
          data = await response.json() as {
            success: boolean;
            errors?: Array<{ message: string }>;
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Worker deployment for script ${args.scriptName} returned a ` +
              `non-JSON response (HTTP ${response.status}): ${message}`,
            { cause: err },
          );
        }

        if (!data.success) {
          const errorMsg = data.errors?.map((e) => e.message).join("; ") ??
            `HTTP ${response.status} with no error detail`;
          throw new Error(
            `Worker deployment failed for script ${args.scriptName}: ${errorMsg}`,
          );
        }

        const handle = await context.writeResource(
          "deployment",
          args.scriptName,
          {
            scriptName: args.scriptName,
            deployedAt: new Date().toISOString(),
            success: true,
            durationMs: Date.now() - startMs,
            collectedBy: EXTENSION_NAME,
            fetchedAt: new Date().toISOString(),
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
        scriptName: z.string().min(1).describe("Worker script name to delete"),
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
        zoneId: z.string().min(1).describe("Zone ID"),
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
        const startMs = Date.now();
        const { apiToken } = context.globalArgs;

        const { results: routes, truncated } = await cfApiPaginated<
          z.infer<typeof WorkerRouteSchema>
        >(
          apiToken,
          `/zones/${args.zoneId}/workers/routes`,
        );

        if (truncated) {
          context.logger.info(
            "WARNING: Worker routes truncated at {count} results (pagination cap reached)",
            { count: routes.length },
          );
        }

        const handle = await context.writeResource("routes", args.zoneId, {
          zoneId: args.zoneId,
          routes,
          truncated,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        zoneId: z.string().min(1).describe("Zone ID"),
        pattern: z.string().describe("Route pattern (e.g., 'example.com/*')"),
        scriptName: z.string().min(1).describe("Worker script name to execute"),
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
        const startMs = Date.now();
        const { apiToken } = context.globalArgs;

        await cfApi<z.infer<typeof WorkerRouteSchema>>(
          apiToken,
          "POST",
          `/zones/${args.zoneId}/workers/routes`,
          { pattern: args.pattern, script: args.scriptName },
        );

        // Refresh routes list
        const { results: routes, truncated } = await cfApiPaginated<
          z.infer<typeof WorkerRouteSchema>
        >(
          apiToken,
          `/zones/${args.zoneId}/workers/routes`,
        );

        const handle = await context.writeResource("routes", args.zoneId, {
          zoneId: args.zoneId,
          routes,
          truncated,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          collectedBy: EXTENSION_NAME,
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
        zoneId: z.string().min(1).describe("Zone ID"),
        routeId: z.string().min(1).describe("Route ID to delete"),
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
        scriptName: z.string().min(1).describe("Worker script name"),
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
