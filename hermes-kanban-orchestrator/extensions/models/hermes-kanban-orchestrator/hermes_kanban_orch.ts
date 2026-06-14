/**
 * Kanban Orchestrator — creates kanban tasks and records them as swamp data.
 *
 * This is the single entry point for creating kanban tasks from swamp
 * workflows, cron jobs, and automation. Every task creation is recorded
 * as versioned swamp data with the kanban ID, type, assignee, and status
 * so the full history is queryable via CEL.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";

// =============================================================================
// Schemas
// =============================================================================

const GlobalArgsSchema = z.object({
  board: z.string().default("research")
    .describe("Kanban board slug to create tasks on"),
  hermesBin: z.string().default("hermes")
    .describe("Path to the hermes binary"),
  repoDir: z.string().default(".")
    .describe("Path to the swamp repo directory"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const TaskType = z.enum(["daily-journal", "research-topic", "weekly-review"]);

const NewTaskArgsSchema = z.object({
  type: TaskType
    .describe("Type of task to create"),
  title: z.string()
    .describe("Task title"),
  assignee: z.string().default("researcher")
    .describe("Hermes profile to assign the task to"),
  body: z.string().optional()
    .describe("Optional body/content for the task"),
  tags: z.array(z.string()).optional()
    .describe("Optional tags for categorization"),
  priority: z.number().int().min(0).max(5).optional()
    .describe("Priority tiebreaker (higher = more important)"),
  idempotencyKey: z.string().optional()
    .describe(
      "Dedup key — if set, a matching non-archived task won't be duplicated",
    ),
});

type NewTaskArgs = z.infer<typeof NewTaskArgsSchema>;

const KanbanTaskSchema = z.object({
  kanbanId: z.string(),
  type: TaskType,
  title: z.string(),
  assignee: z.string(),
  status: z.string(),
  priority: z.number().int().min(0).max(5).optional(),
  tags: z.array(z.string()).optional(),
  bodyPreview: z.string().optional(),
  createdAt: z.string(),
});

const ListRecentArgsSchema = z.object({
  type: TaskType.optional()
    .describe("Filter by task type"),
  limit: z.number().int().min(1).max(50).default(10)
    .describe("Max results to return"),
});

// =============================================================================
// Context
// =============================================================================

interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    spec: string,
    instance: string,
    data: unknown,
  ) => Promise<{ name: string; spec: string; instance: string }>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warn: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// =============================================================================
// Helpers
// =============================================================================

async function runHermesKanban(
  hermesBin: string,
  repoDir: string,
  board: string,
  args: string[],
): Promise<{ stdout: string; success: boolean }> {
  const cmd = [
    hermesBin,
    "kanban",
    "--board",
    board,
    ...args,
  ];

  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd: repoDir,
  });

  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();

  if (!output.success) {
    return { stdout: stderr || stdout, success: false };
  }
  return { stdout, success: true };
}

function generateIdempotencyKey(type: string, _tags?: string[]): string {
  // For daily-journal, key on date so we never create duplicates
  if (type === "daily-journal") {
    const today = new Date().toISOString().slice(0, 10);
    return `daily-journal-${today}`;
  }
  // For other types, use provided key or let hermes generate one
  return crypto.randomUUID();
}

// =============================================================================
// Methods
// =============================================================================

async function newTask(
  args: NewTaskArgs,
  ctx: MethodContext,
): Promise<
  { dataHandles: { spec: string; instance: string; name: string }[] }
> {
  const cfg = ctx.globalArgs;
  ctx.logger.info("Creating kanban task", {
    type: args.type,
    assignee: args.assignee,
  });

  const kanbanArgs: string[] = [];

  if (args.body) {
    kanbanArgs.push("--body", args.body);
  }
  if (args.assignee) {
    kanbanArgs.push("--assignee", args.assignee);
  }
  if (args.priority !== undefined) {
    kanbanArgs.push("--priority", String(args.priority));
  }

  const key = args.idempotencyKey ||
    generateIdempotencyKey(args.type, args.tags);
  if (key) {
    kanbanArgs.push("--idempotency-key", key);
  }

  kanbanArgs.push("--json");
  kanbanArgs.push(args.title);

  const result = await runHermesKanban(
    cfg.hermesBin,
    cfg.repoDir,
    cfg.board,
    ["create", ...kanbanArgs],
  );

  if (!result.success) {
    // Check if it's a duplicate (idempotency key matched)
    if (result.stdout.includes("already exists")) {
      ctx.logger.info("Kanban task already exists (idempotency key matched)", {
        key,
      });
      // Try to extract the existing task ID from the output
      const idMatch = result.stdout.match(/[0-9a-f]{12}/);
      const taskId = idMatch ? idMatch[0] : "unknown";

      const handle = await ctx.writeResource("kanbanTask", `task-${taskId}`, {
        kanbanId: taskId,
        type: args.type,
        title: args.title,
        assignee: args.assignee,
        status: "exists",
        tags: args.tags ?? [],
        createdAt: new Date().toISOString(),
      });
      return { dataHandles: [handle] };
    }

    throw new Error(`Failed to create kanban task: ${result.stdout}`);
  }

  // Parse the JSON output to extract task ID
  let taskId = "unknown";
  try {
    const parsed = JSON.parse(result.stdout);
    taskId = String(parsed.id || parsed.taskId || parsed.task_id || "");
  } catch {
    // Fallback: extract from output text
    const idMatch = result.stdout.match(/[0-9a-f]{12}/);
    if (idMatch) taskId = idMatch[0];
  }

  const handle = await ctx.writeResource("kanbanTask", `task-${taskId}`, {
    kanbanId: taskId,
    type: args.type,
    title: args.title,
    assignee: args.assignee,
    status: "created",
    priority: args.priority,
    tags: args.tags ?? [],
    bodyPreview: args.body ? args.body.slice(0, 200) : undefined,
    createdAt: new Date().toISOString(),
  });

  ctx.logger.info(`Kanban task created: ${taskId}`);
  return { dataHandles: [handle] };
}

async function listRecent(
  args: z.infer<typeof ListRecentArgsSchema>,
  ctx: MethodContext,
): Promise<
  { dataHandles: { spec: string; instance: string; name: string }[] }
> {
  ctx.logger.info("Listing recent kanban tasks");

  const kanbanArgs = ["--json"];
  if (args.type) {
    kanbanArgs.push("--type", args.type, "--status", "all");
  }
  kanbanArgs.push("list");

  const result = await runHermesKanban(
    ctx.globalArgs.hermesBin,
    ctx.globalArgs.repoDir,
    ctx.globalArgs.board,
    kanbanArgs,
  );

  if (!result.success) {
    ctx.logger.warn("Failed to list kanban tasks", { error: result.stdout });
    return { dataHandles: [] };
  }

  // Parse list output
  let tasks: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(result.stdout);
    tasks = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
        ? parsed.tasks
        : Array.isArray(parsed.results)
          ? parsed.results
          : [];
  } catch {
    ctx.logger.warn("Could not parse kanban list output");
  }

  tasks = tasks.slice(0, args.limit);
  const handles = await Promise.all(
    tasks.map((task, i) => {
      const id = String(task.id || task.taskId || i);
      return ctx.writeResource("kanbanTask", `list-${id}`, {
        kanbanId: id,
        title: task.title ?? "",
        status: task.status ?? "unknown",
        assignee: task.assignee ?? "",
        type: task.type ?? "unknown",
        createdAt: new Date().toISOString(),
      });
    }),
  );

  return { dataHandles: handles };
}

// =============================================================================
// Model Export
// =============================================================================

/** Kanban orchestrator model. Creates kanban tasks via `hermes kanban create` and records each as swamp data. */
export const model = {
  type: "@webframp/hermes-kanban-orchestrator" as const,
  version: "2026.06.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    kanbanTask: {
      description:
        "Record of a kanban task with its ID, type, assignee, and status",
      schema: KanbanTaskSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    new_task: {
      description:
        "Create a kanban task and record it in swamp data. Supports idempotency for daily-journal tasks.",
      arguments: NewTaskArgsSchema,
      execute: newTask,
    },
    list_recent: {
      description: "List recent kanban tasks and record them as swamp data.",
      arguments: ListRecentArgsSchema,
      execute: listRecent,
    },
  },
};
