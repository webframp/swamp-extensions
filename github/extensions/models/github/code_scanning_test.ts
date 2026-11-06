import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { extension } from "./code_scanning.ts";
import { model } from "./repos.ts";

const REPO = "webframp/swamp-extensions";
const methods = extension.methods[0];

type Responder = (argv: string[], call: number) => {
  success?: boolean;
  stdout?: unknown;
  stderr?: string;
  /** Make the subprocess promise reject with this (possibly non-Error) value. */
  reject?: unknown;
};

/** Replace Deno.Command with a stub that records argv; returns calls + restore. */
function mockGh(responder: Responder) {
  const original = Deno.Command;
  const calls: string[][] = [];
  // deno-lint-ignore no-explicit-any
  (Deno as any).Command = class MockCommand {
    #args: string[];
    constructor(_command: string, options: { args: string[] }) {
      this.#args = options.args;
    }
    output() {
      calls.push(this.#args);
      const r = responder(this.#args, calls.length);
      if (r.reject !== undefined) return Promise.reject(r.reject);
      return Promise.resolve({
        success: r.success ?? true,
        stdout: new TextEncoder().encode(
          r.stdout === undefined ? "" : JSON.stringify(r.stdout),
        ),
        stderr: new TextEncoder().encode(r.stderr ?? ""),
      });
    }
  };
  return {
    calls,
    // deno-lint-ignore no-explicit-any
    restore: () => ((Deno as any).Command = original),
  };
}

/** The `page` query parameter of a recorded `gh api repos/.../alerts?...` call. */
function pageOf(argv: string[]): number {
  return Number(new URL(`https://x/${argv[1]}`).searchParams.get("page"));
}

function rawAlert(n: number, over: Record<string, unknown> = {}) {
  return {
    number: n,
    state: "open",
    created_at: "2026-11-06T00:00:00Z",
    updated_at: "2026-11-06T00:00:00Z",
    html_url: `https://github.com/${REPO}/security/code-scanning/${n}`,
    dismissed_reason: null,
    rule: {
      id: "js/incomplete-sanitization",
      severity: "warning",
      security_severity_level: "high",
      description: "Incomplete string escaping or encoding",
    },
    tool: { name: "CodeQL", version: "2.27.4" },
    most_recent_instance: {
      ref: "refs/heads/main",
      location: { path: "a/b_test.ts", start_line: 10, end_line: 10 },
    },
    ...over,
  };
}

Deno.test("code-scanning augmentation exposes only its scoped methods", () => {
  assertEquals(Object.keys(methods).sort(), [
    "dismiss_code_scanning_alert",
    "dismiss_code_scanning_alerts",
    "get_code_scanning_alert",
    "list_code_scanning_alerts",
    "reopen_code_scanning_alert",
  ]);
});

Deno.test("every resource spec the methods write is declared on the model", () => {
  for (
    const spec of [
      "codeScanningAlert",
      "codeScanningSummary",
      "codeScanningAlertDetail",
      "triageAction",
    ]
  ) {
    assert(spec in model.resources, `${spec} missing from model.resources`);
  }
});

Deno.test("list writes one instance per alert and the summary last", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({
    stdout: [rawAlert(3), rawAlert(2), rawAlert(1)],
  }));
  try {
    const result = await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(
      written.map((w) => w.name),
      [
        `${encodeURIComponent(REPO)}~alert~3`,
        `${encodeURIComponent(REPO)}~alert~2`,
        `${encodeURIComponent(REPO)}~alert~1`,
        `${encodeURIComponent(REPO)}~summary`,
      ],
    );
    assertEquals(result.dataHandles.length, 4);
    const summary = written[3].data as Record<string, unknown>;
    assertEquals(summary.total, 3);
    assertEquals(summary.truncated, false);
    assertEquals(summary.alertNumbers, [3, 2, 1]);
    assertEquals(summary.countsByRule, { "js/incomplete-sanitization": 3 });
    assertEquals(summary.countsBySeverity, { high: 3 });
    const first = written[0].data as Record<string, unknown>;
    assertEquals(first.snapshotId, summary.snapshotId);
    assertEquals(first.path, "a/b_test.ts");
    assertEquals(first.securitySeverityLevel, "high");
    assertEquals(gh.calls.length, 2);
  } finally {
    gh.restore();
  }
});

Deno.test("list paginates and passes filters to the API query", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const page1 = Array.from({ length: 100 }, (_, i) => rawAlert(150 - i));
  const page2 = Array.from({ length: 50 }, (_, i) => rawAlert(50 - i));
  const gh = mockGh((argv) => ({ stdout: pageOf(argv) === 1 ? page1 : page2 }));
  try {
    await methods.list_code_scanning_alerts.execute(
      {
        repo: REPO,
        state: "open",
        severity: "high",
        tool: "CodeQL",
        ref: "refs/heads/main",
        maxAlerts: 1000,
      },
      context as never,
    );
    assertEquals(gh.calls.length, 4);
    const url = new URL(`https://x/${gh.calls[0][1]}`);
    assertEquals(gh.calls[0][0], "api");
    assertEquals(url.pathname, `/repos/${REPO}/code-scanning/alerts`);
    assertEquals(url.searchParams.get("state"), "open");
    assertEquals(url.searchParams.get("severity"), "high");
    assertEquals(url.searchParams.get("tool_name"), "CodeQL");
    assertEquals(url.searchParams.get("ref"), "refs/heads/main");
    assertEquals(url.searchParams.get("page"), "1");
    assertEquals(
      new URL(`https://x/${gh.calls[1][1]}`).searchParams.get("page"),
      "2",
    );
    const summary = getWrittenResources().at(-1)!.data as Record<
      string,
      unknown
    >;
    assertEquals(summary.total, 150);
    assertEquals(summary.truncated, false);
    assertEquals(summary.filters, {
      state: "open",
      severity: "high",
      tool: "CodeQL",
      ref: "refs/heads/main",
    });
  } finally {
    gh.restore();
  }
});

Deno.test("list flags truncation exactly when more than maxAlerts match", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({
    stdout: [rawAlert(4), rawAlert(3), rawAlert(2), rawAlert(1)],
  }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 3 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 4); // 3 alerts + summary
    const summary = written.at(-1)!.data as Record<string, unknown>;
    assertEquals(summary.total, 3);
    assertEquals(summary.truncated, true);
    assertEquals(summary.alertNumbers, [4, 3, 2]);
  } finally {
    gh.restore();
  }
});

Deno.test("list does not flag truncation when exactly maxAlerts match", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({
    stdout: [rawAlert(3), rawAlert(2), rawAlert(1)],
  }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 3 },
      context as never,
    );
    const summary = getWrittenResources().at(-1)!.data as Record<
      string,
      unknown
    >;
    assertEquals(summary.truncated, false);
  } finally {
    gh.restore();
  }
});

Deno.test("list writes an empty summary when no alerts match", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: [] }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    const summary = written[0].data as Record<string, unknown>;
    assertEquals(summary.total, 0);
    assertEquals(summary.alertNumbers, []);
  } finally {
    gh.restore();
  }
});

Deno.test("list rejects a non-array response and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: { message: "nope" } }));
  try {
    await assertRejects(
      () =>
        methods.list_code_scanning_alerts.execute(
          { repo: REPO, maxAlerts: 1000 },
          context as never,
        ),
      Error,
      "expected an array",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    gh.restore();
  }
});

Deno.test("list tolerates sparse alerts missing optional fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: [{ number: 9 }] }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    const alert = getWrittenResources()[0].data as Record<string, unknown>;
    assertEquals(alert.ruleId, "unknown");
    assertEquals(alert.path, null);
    const summary = getWrittenResources().at(-1)!.data as Record<
      string,
      unknown
    >;
    assertEquals(summary.countsBySeverity, { unknown: 1 });
  } finally {
    gh.restore();
  }
});

Deno.test("get stores the full alert under a per-repo, per-number name", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: rawAlert(42) }));
  try {
    await methods.get_code_scanning_alert.execute(
      { repo: REPO, number: 42 },
      context as never,
    );
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(
      written[0].name,
      `${encodeURIComponent(REPO)}~alert-detail~42`,
    );
    assertEquals(gh.calls[0], [
      "api",
      `repos/${REPO}/code-scanning/alerts/42`,
    ]);
    const data = written[0].data as { number: number; context: unknown };
    assertEquals(data.number, 42);
    assertEquals((data.context as { number: number }).number, 42);
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss sends a PATCH with raw -f fields and records evidence", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({
    stdout: rawAlert(7, {
      state: "dismissed",
      dismissed_reason: "used in tests",
      dismissed_at: "2026-11-06T01:00:00Z",
    }),
  }));
  try {
    await methods.dismiss_code_scanning_alert.execute(
      {
        repo: REPO,
        number: 7,
        reason: "used_in_tests",
        comment: "Test fixture",
        idempotencyKey: "dismiss-7",
      },
      context as never,
    );
    assertEquals(gh.calls[0], [
      "api",
      "--method",
      "PATCH",
      `repos/${REPO}/code-scanning/alerts/7`,
      "-f",
      "state=dismissed",
      "-f",
      "dismissed_reason=used in tests",
      "-f",
      "dismissed_comment=Test fixture",
    ]);
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(
      written[0].name,
      `${encodeURIComponent(REPO)}~dismiss~7~dismiss-7`,
    );
    const data = written[0].data as {
      action: string;
      target: number;
      result: { alert: { state: string }; reason: string; comment: string };
    };
    assertEquals(data.action, "dismiss_code_scanning_alert");
    assertEquals(data.target, 7);
    assertEquals(data.result.alert.state, "dismissed");
    assertEquals(data.result.reason, "used_in_tests");
    assertEquals(data.result.comment, "Test fixture");
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss passes an @-prefixed comment as a raw -f field, never -F", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh(() => ({ stdout: rawAlert(7, { state: "dismissed" }) }));
  try {
    await methods.dismiss_code_scanning_alert.execute(
      {
        repo: REPO,
        number: 7,
        reason: "wont_fix",
        comment: "@/etc/passwd",
        idempotencyKey: "dismiss-at",
      },
      context as never,
    );
    const argv = gh.calls[0];
    assertEquals(argv.includes("-F"), false);
    assertEquals(argv.includes("--field"), false);
    assertEquals(argv.at(-2), "-f");
    assertEquals(argv.at(-1), "dismissed_comment=@/etc/passwd");
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss does not call gh twice for the same alert and key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: rawAlert(7, { state: "dismissed" }) }));
  try {
    const args = {
      repo: REPO,
      number: 7,
      reason: "false_positive" as const,
      comment: "Not reachable",
      idempotencyKey: "dismiss-7",
    };
    await methods.dismiss_code_scanning_alert.execute(args, context as never);
    const second = await methods.dismiss_code_scanning_alert.execute(
      args,
      context as never,
    );
    assertEquals(gh.calls.length, 1);
    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written[1].data, written[0].data);
    assertEquals(second.dataHandles.length, 1);
    const handle = second.dataHandles[0] as Record<string, unknown>;
    assertEquals(typeof handle.dataId, "string");
    assertEquals(typeof handle.version, "number");
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss with one key on two alerts dismisses both", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh((argv) => {
    const n = Number(
      argv.find((a) => a.includes("/alerts/"))?.split("/").pop(),
    );
    return { stdout: rawAlert(n, { state: "dismissed" }) };
  });
  try {
    const base = {
      repo: REPO,
      reason: "used_in_tests" as const,
      comment: "Test fixture",
      idempotencyKey: "bulk-1",
    };
    await methods.dismiss_code_scanning_alert.execute(
      { ...base, number: 1 },
      context as never,
    );
    await methods.dismiss_code_scanning_alert.execute(
      { ...base, number: 2 },
      context as never,
    );
    assertEquals(gh.calls.length, 2);
    assert(gh.calls[0].includes(`repos/${REPO}/code-scanning/alerts/1`));
    assert(gh.calls[1].includes(`repos/${REPO}/code-scanning/alerts/2`));
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss redacts the comment from a gh failure message", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ success: false, stderr: "HTTP 403" }));
  try {
    let message = "";
    try {
      await methods.dismiss_code_scanning_alert.execute(
        {
          repo: REPO,
          number: 7,
          reason: "wont_fix",
          comment: "Sensitive rationale text",
          idempotencyKey: "dismiss-fail",
        },
        context as never,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("HTTP 403"));
    assert(message.includes("dismissed_comment=[redacted]"));
    assertEquals(message.includes("Sensitive"), false);
    assertEquals(getWrittenResources().length, 0);
  } finally {
    gh.restore();
  }
});

Deno.test("a failed dismiss leaves no marker so a retry can run", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((_argv, call) =>
    call === 1
      ? { success: false, stderr: "HTTP 502" }
      : { stdout: rawAlert(7, { state: "dismissed" }) }
  );
  try {
    const args = {
      repo: REPO,
      number: 7,
      reason: "wont_fix" as const,
      comment: "Accepted risk",
      idempotencyKey: "dismiss-retry",
    };
    await assertRejects(() =>
      methods.dismiss_code_scanning_alert.execute(args, context as never)
    );
    assertEquals(getWrittenResources().length, 0);
    await methods.dismiss_code_scanning_alert.execute(args, context as never);
    assertEquals(gh.calls.length, 2);
    assertEquals(getWrittenResources().length, 1);
  } finally {
    gh.restore();
  }
});

Deno.test("dismiss rejects bad reasons, long comments, empty comments, and extra keys", () => {
  const schema = methods.dismiss_code_scanning_alert.arguments;
  const ok = {
    repo: REPO,
    number: 7,
    reason: "used_in_tests",
    comment: "x",
    idempotencyKey: "k",
  };
  assert(schema.safeParse(ok).success);
  assert(schema.safeParse({ ...ok, reason: "mitigated" }).success);
  // The API's own spellings are not accepted; callers use snake_case keys.
  assertEquals(
    schema.safeParse({ ...ok, reason: "used in tests" }).success,
    false,
  );
  assertEquals(schema.safeParse({ ...ok, reason: "other" }).success, false);
  assertEquals(
    schema.safeParse({ ...ok, comment: "x".repeat(281) }).success,
    false,
  );
  assert(schema.safeParse({ ...ok, comment: "x".repeat(280) }).success);
  assertEquals(schema.safeParse({ ...ok, comment: "" }).success, false);
  assertEquals(schema.safeParse({ ...ok, extra: 1 }).success, false);
  assertEquals(schema.safeParse({ ...ok, number: 0 }).success, false);
});

Deno.test("repo slugs with . or .. segments are rejected on every method", () => {
  for (const bad of ["../x", "x/..", "./x", "x/.", "../.."]) {
    assertEquals(
      methods.get_code_scanning_alert.arguments.safeParse({
        repo: bad,
        number: 1,
      }).success,
      false,
      bad,
    );
  }
  assert(
    methods.get_code_scanning_alert.arguments.safeParse({
      repo: "a.b/c-d_e",
      number: 1,
    }).success,
  );
});

Deno.test("list rejects maxAlerts outside 1..1000 and unknown filters", () => {
  const schema = methods.list_code_scanning_alerts.arguments;
  assertEquals(schema.safeParse({ repo: REPO, maxAlerts: 0 }).success, false);
  assertEquals(
    schema.safeParse({ repo: REPO, maxAlerts: 1001 }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ repo: REPO, state: "all" }).success,
    false,
  );
  assertEquals(
    schema.parse({ repo: REPO }).maxAlerts,
    1000,
  );
});

Deno.test("reopen sends state=open and is idempotent per alert and key", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: rawAlert(7) }));
  try {
    const args = { repo: REPO, number: 7, idempotencyKey: "reopen-7" };
    await methods.reopen_code_scanning_alert.execute(args, context as never);
    await methods.reopen_code_scanning_alert.execute(args, context as never);
    assertEquals(gh.calls.length, 1);
    assertEquals(gh.calls[0], [
      "api",
      "--method",
      "PATCH",
      `repos/${REPO}/code-scanning/alerts/7`,
      "-f",
      "state=open",
    ]);
    const written = getWrittenResources();
    assertEquals(
      written[0].name,
      `${encodeURIComponent(REPO)}~reopen~7~reopen-7`,
    );
    assertEquals(
      (written[0].data as { action: string }).action,
      "reopen_code_scanning_alert",
    );
  } finally {
    gh.restore();
  }
});

Deno.test("idempotencyKey rejects characters that could break marker names", () => {
  assertThrows(() =>
    methods.reopen_code_scanning_alert.arguments.parse({
      repo: REPO,
      number: 1,
      idempotencyKey: "a/b",
    })
  );
});

Deno.test("every caller-facing dismiss reason maps to a string the API accepts", async () => {
  // The exact membership list GitHub returned in its HTTP 422 for an invalid
  // dismissed_reason, captured from the live API on 2026-11-06. It is the
  // source of truth for these strings, not something derived from the code.
  const apiAccepts = [
    "false positive",
    "won't fix",
    "used in tests",
    "mitigated",
  ];
  const expected: Record<string, string> = {
    false_positive: "false positive",
    wont_fix: "won't fix",
    used_in_tests: "used in tests",
    mitigated: "mitigated",
  };
  for (const [reason, apiReason] of Object.entries(expected)) {
    assert(apiAccepts.includes(apiReason));
    const { context } = createModelTestContext({ globalArgs: {} });
    const gh = mockGh(() => ({ stdout: rawAlert(7, { state: "dismissed" }) }));
    try {
      await methods.dismiss_code_scanning_alert.execute(
        {
          repo: REPO,
          number: 7,
          reason,
          comment: "c",
          idempotencyKey: `k-${reason}`,
        } as never,
        context as never,
      );
      assert(gh.calls[0].includes(`dismissed_reason=${apiReason}`), reason);
    } finally {
      gh.restore();
    }
  }
});

Deno.test("dismiss and reopen refuse to record a change GitHub did not confirm", async () => {
  for (
    const stdout of [undefined, null, "not json", rawAlert(7), rawAlert(8)]
  ) {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
    });
    const gh = mockGh(() => ({ stdout }));
    try {
      await assertRejects(
        () =>
          methods.dismiss_code_scanning_alert.execute(
            {
              repo: REPO,
              number: 7,
              reason: "wont_fix",
              comment: "c",
              idempotencyKey: "unconfirmed",
            },
            context as never,
          ),
        Error,
        "was not confirmed dismissed",
      );
      assertEquals(getWrittenResources().length, 0);
    } finally {
      gh.restore();
    }
  }
  for (const stdout of [undefined, rawAlert(7, { state: "dismissed" })]) {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
    });
    const gh = mockGh(() => ({ stdout }));
    try {
      await assertRejects(
        () =>
          methods.reopen_code_scanning_alert.execute(
            { repo: REPO, number: 7, idempotencyKey: "unconfirmed" },
            context as never,
          ),
        Error,
        "was not confirmed open",
      );
      assertEquals(getWrittenResources().length, 0);
    } finally {
      gh.restore();
    }
  }
});

Deno.test("get rejects an empty or mismatched response and writes nothing", async () => {
  for (const stdout of [undefined, rawAlert(99)]) {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: {},
    });
    const gh = mockGh(() => ({ stdout }));
    try {
      await assertRejects(
        () =>
          methods.get_code_scanning_alert.execute(
            { repo: REPO, number: 42 },
            context as never,
          ),
        Error,
        "expected that alert",
      );
      assertEquals(getWrittenResources().length, 0);
    } finally {
      gh.restore();
    }
  }
});

Deno.test("list rejects a row without an integer number and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({ stdout: [rawAlert(2), { state: "open" }] }));
  try {
    await assertRejects(
      () =>
        methods.list_code_scanning_alerts.execute(
          { repo: REPO, maxAlerts: 1000 },
          context as never,
        ),
      Error,
      "without an integer number",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    gh.restore();
  }
});

Deno.test("list and get never share an instance name across specs", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((argv) =>
    argv[1].includes("/alerts/")
      ? { stdout: rawAlert(42) }
      : { stdout: [rawAlert(42)] }
  );
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    await methods.get_code_scanning_alert.execute(
      { repo: REPO, number: 42 },
      context as never,
    );
    const names = getWrittenResources().map((w) => w.name);
    assertEquals(new Set(names).size, names.length, names.join(", "));
  } finally {
    gh.restore();
  }
});

/**
 * Give a test context a working fake store: readModelData returns the latest
 * live write per instance name for a spec, and deleteResource removes one.
 * The harness provides neither deletion nor a readable store.
 */
function withStore(
  harness: ReturnType<typeof createModelTestContext>,
  failDeleteFor: Set<string> = new Set(),
) {
  const deleted: string[] = [];
  const deletedAt = new Map<string, number>();
  const c = harness.context as unknown as Record<string, unknown>;
  c.readModelData = (_model: string, spec?: string) => {
    const written = harness.getWrittenResources();
    const latest = new Map<string, { name: string; attributes: unknown }>();
    written.forEach((w, index) => {
      if ((w as { specName?: string }).specName !== spec) return;
      if (index < (deletedAt.get(w.name) ?? 0)) return;
      latest.set(w.name, { name: w.name, attributes: w.data });
    });
    return Promise.resolve([...latest.values()]);
  };
  c.deleteResource = (name: string) => {
    if (failDeleteFor.has(name)) return Promise.reject(new Error("disk busy"));
    deleted.push(name);
    deletedAt.set(name, harness.getWrittenResources().length);
    return Promise.resolve();
  };
  return { deleted };
}

Deno.test("a second snapshot prunes alerts the first listed and the second did not", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context } = harness;
  const { deleted } = withStore(harness);
  let snapshot = [rawAlert(3), rawAlert(2), rawAlert(1)];
  const gh = mockGh(() => ({ stdout: snapshot }));
  try {
    const run = () =>
      methods.list_code_scanning_alerts.execute(
        { repo: REPO, state: "open", maxAlerts: 1000 },
        context as never,
      );
    await run();
    assertEquals(deleted, []);
    // Alert 3 is fixed and a new alert 4 appears between runs.
    snapshot = [rawAlert(4), rawAlert(2), rawAlert(1)];
    await run();
    assertEquals(deleted, [`${encodeURIComponent(REPO)}~alert~3`]);
    // Nothing changed: nothing further is pruned.
    await run();
    assertEquals(deleted.length, 1);
  } finally {
    gh.restore();
  }
});

Deno.test("prune finds orphans left by a run that died before writing its summary", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context } = harness;
  const { deleted } = withStore(harness);
  const gh = mockGh(() => ({ stdout: [rawAlert(1)] }));
  try {
    const stored = (repo: string, number: number) => ({
      repo,
      number,
      snapshotId: "2026-11-05T00:00:00Z",
    });
    // Alert 9 was written by a crashed run: no summary ever listed it.
    await context.writeResource(
      "codeScanningAlert",
      `${encodeURIComponent(REPO)}~alert~9`,
      stored(REPO, 9),
    );
    // Another repo's alert in the same model must be left alone.
    await context.writeResource(
      "codeScanningAlert",
      `${encodeURIComponent("other/repo")}~alert~5`,
      stored("other/repo", 5),
    );
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    assertEquals(deleted, [`${encodeURIComponent(REPO)}~alert~9`]);
  } finally {
    gh.restore();
  }
});

Deno.test("a failed prune delete keeps the snapshot, attempts the rest, and the next run retries", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context } = harness;
  const name = (n: number) => `${encodeURIComponent(REPO)}~alert~${n}`;
  const failing = new Set([name(8)]);
  const { deleted } = withStore(harness, failing);
  const gh = mockGh(() => ({ stdout: [rawAlert(1)] }));
  try {
    for (const n of [8, 9]) {
      await context.writeResource("codeScanningAlert", name(n), {
        repo: REPO,
        number: n,
      });
    }
    await assertRejects(
      () =>
        methods.list_code_scanning_alerts.execute(
          { repo: REPO, maxAlerts: 1000 },
          context as never,
        ),
      Error,
      "Snapshot written, but 1 superseded alert(s) could not be deleted",
    );
    // The snapshot itself was committed, and 9 was still pruned after 8 failed.
    assert(
      harness.getWrittenResources().some((w) => w.name.endsWith("~summary")),
    );
    assertEquals(deleted, [name(9)]);
    failing.clear();
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    assertEquals(deleted, [name(9), name(8)]);
  } finally {
    gh.restore();
  }
});

Deno.test("list counts an alert repeated across pages once", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const page1 = Array.from({ length: 100 }, (_, i) => rawAlert(150 - i)); // 150..51
  // A new alert shifted row 51 onto page 2 as well.
  const page2 = [
    rawAlert(51),
    ...Array.from({ length: 49 }, (_, i) => rawAlert(50 - i)),
  ];
  const gh = mockGh((argv) => ({ stdout: pageOf(argv) === 1 ? page1 : page2 }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    const summary = getWrittenResources().at(-1)!.data as {
      total: number;
      alertNumbers: number[];
    };
    assertEquals(summary.total, 149);
    assertEquals(new Set(summary.alertNumbers).size, 149);
  } finally {
    gh.restore();
  }
});

Deno.test("a repeated row does not push the count past maxAlerts and fake a truncation", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const page1 = Array.from({ length: 100 }, (_, i) => rawAlert(100 - i));
  const gh = mockGh((argv) => ({
    stdout: pageOf(argv) === 1 ? page1 : [rawAlert(1), rawAlert(2)], // both already seen
  }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 100 },
      context as never,
    );
    const summary = getWrittenResources().at(-1)!.data as {
      total: number;
      truncated: boolean;
    };
    assertEquals(summary.total, 100);
    assertEquals(summary.truncated, false);
  } finally {
    gh.restore();
  }
});

Deno.test("every written record conforms to its declared resource schema", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((argv) => {
    if (argv.includes("PATCH")) {
      return {
        stdout: rawAlert(7, {
          state: argv.includes("state=open") ? "open" : "dismissed",
        }),
      };
    }
    return argv[1].includes("/alerts/7")
      ? { stdout: rawAlert(7) }
      : { stdout: [rawAlert(7), { number: 8 }] };
  });
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, state: "open", maxAlerts: 1000 },
      context as never,
    );
    await methods.get_code_scanning_alert.execute(
      { repo: REPO, number: 7 },
      context as never,
    );
    await methods.dismiss_code_scanning_alert.execute(
      {
        repo: REPO,
        number: 7,
        reason: "used_in_tests",
        comment: "c",
        idempotencyKey: "k1",
      },
      context as never,
    );
    await methods.reopen_code_scanning_alert.execute(
      { repo: REPO, number: 7, idempotencyKey: "k2" },
      context as never,
    );
    const specOf = (name: string) =>
      name.endsWith("~summary")
        ? "codeScanningSummary"
        : name.includes("~alert-detail~")
        ? "codeScanningAlertDetail"
        : name.includes("~alert~")
        ? "codeScanningAlert"
        : "triageAction";
    const written = getWrittenResources();
    assertEquals(written.length, 6); // 2 alerts + summary + detail + 2 actions
    for (const w of written) {
      const spec = specOf(w.name);
      const schema = (model.resources as Record<
        string,
        { schema: { parse: (v: unknown) => unknown } }
      >)[
        spec
      ].schema;
      schema.parse(w.data); // throws with the offending path on mismatch
    }
  } finally {
    gh.restore();
  }
});

/** gh responder that echoes the alert number from the PATCH endpoint. */
function patchResponder(failFor: number[] = []): Responder {
  return (argv) => {
    const n = Number(
      argv.find((a) => a.includes("/alerts/"))?.split("/").pop(),
    );
    return failFor.includes(n)
      ? { success: false, stderr: `HTTP 502 for ${n}` }
      : { stdout: rawAlert(n, { state: "dismissed" }) };
  };
}

const bulkArgs = {
  repo: REPO,
  numbers: [10, 11, 12],
  reason: "used_in_tests" as const,
  comment: "Test fixture",
  idempotencyKey: "bulk-a",
  pauseMs: 0,
};

Deno.test("bulk dismiss makes one PATCH per alert and records one marker each", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(patchResponder());
  try {
    const result = await methods.dismiss_code_scanning_alerts.execute(
      bulkArgs,
      context as never,
    );
    assertEquals(gh.calls.length, 3);
    assertEquals(result.dataHandles.length, 3);
    const written = getWrittenResources();
    assertEquals(
      written.map((w) => w.name),
      [10, 11, 12].map((n) =>
        `${encodeURIComponent(REPO)}~dismiss~${n}~bulk-a`
      ),
    );
    for (const call of gh.calls) {
      assert(call.includes("dismissed_reason=used in tests"));
      assert(call.includes("dismissed_comment=Test fixture"));
    }
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss continues past a failure, keeps successes, then reports the failure", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(patchResponder([11]));
  try {
    const error = await assertRejects(
      () =>
        methods.dismiss_code_scanning_alerts.execute(
          bulkArgs,
          context as never,
        ),
      Error,
      "1 problem(s) in 3 alerts (2 dismissed and recorded",
    );
    assert(error.message.includes("#11: "));
    assert(error.message.includes("HTTP 502 for 11"));
    assertEquals(gh.calls.length, 3); // 12 was still attempted after 11 failed
    assertEquals(getWrittenResources().map((w) => w.name), [
      `${encodeURIComponent(REPO)}~dismiss~10~bulk-a`,
      `${encodeURIComponent(REPO)}~dismiss~12~bulk-a`,
    ]);
    assertEquals(error.message.includes("Test fixture"), false); // redacted
  } finally {
    gh.restore();
  }
});

Deno.test("rerunning a partly failed bulk call retries only the failures", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  let failFor = [11];
  const gh = mockGh((argv, call) => patchResponder(failFor)(argv, call));
  try {
    await assertRejects(() =>
      methods.dismiss_code_scanning_alerts.execute(bulkArgs, context as never)
    );
    assertEquals(gh.calls.length, 3);
    failFor = [];
    const result = await methods.dismiss_code_scanning_alerts.execute(
      bulkArgs,
      context as never,
    );
    assertEquals(gh.calls.length, 4); // only #11 hit GitHub again
    assert(gh.calls[3].includes(`repos/${REPO}/code-scanning/alerts/11`));
    assertEquals(result.dataHandles.length, 3);
    assertEquals(
      new Set(getWrittenResources().map((w) => w.name)).size,
      3,
    );
  } finally {
    gh.restore();
  }
});

Deno.test("bulk and single dismiss share markers for the same alert and key", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh(patchResponder());
  try {
    await methods.dismiss_code_scanning_alert.execute(
      {
        repo: REPO,
        number: 10,
        reason: "used_in_tests",
        comment: "Test fixture",
        idempotencyKey: "bulk-a",
      },
      context as never,
    );
    await methods.dismiss_code_scanning_alerts.execute(
      bulkArgs,
      context as never,
    );
    assertEquals(gh.calls.length, 3); // #10 skipped by the bulk call
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss rejects empty, duplicate, oversized, and invalid number lists", () => {
  const schema = methods.dismiss_code_scanning_alerts.arguments;
  assert(schema.safeParse(bulkArgs).success);
  assertEquals(schema.safeParse({ ...bulkArgs, numbers: [] }).success, false);
  assertEquals(
    schema.safeParse({ ...bulkArgs, numbers: [1, 1] }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ ...bulkArgs, numbers: [0] }).success,
    false,
  );
  assertEquals(
    schema.safeParse({ ...bulkArgs, numbers: [1.5] }).success,
    false,
  );
  const many = Array.from({ length: 201 }, (_, i) => i + 1);
  assertEquals(schema.safeParse({ ...bulkArgs, numbers: many }).success, false);
  assert(
    schema.safeParse({ ...bulkArgs, numbers: many.slice(0, 200) }).success,
  );
  assertEquals(
    schema.safeParse({ ...bulkArgs, number: 1 }).success,
    false,
  );
});

Deno.test("bulk dismiss stops at a rate limit and names the alerts it never attempted", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((argv) => {
    const n = Number(
      argv.find((a) => a.includes("/alerts/"))?.split("/").pop(),
    );
    return n === 11
      ? { success: false, stderr: "gh: API rate limit exceeded (HTTP 403)" }
      : { stdout: rawAlert(n, { state: "dismissed" }) };
  });
  try {
    const error = await assertRejects(
      () =>
        methods.dismiss_code_scanning_alerts.execute(
          { ...bulkArgs, numbers: [10, 11, 12, 13] },
          context as never,
        ),
      Error,
      "not attempted because GitHub is rate limiting: #12, #13",
    );
    assert(error.message.includes("1 dismissed and recorded"));
    assertEquals(gh.calls.length, 2); // 12 and 13 never reached GitHub
    assertEquals(getWrittenResources().length, 1);
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss reports a non-Error rejection and keeps going", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((argv) => {
    const n = Number(
      argv.find((a) => a.includes("/alerts/"))?.split("/").pop(),
    );
    return n === 10
      ? { reject: "spawn exploded" }
      : { stdout: rawAlert(n, { state: "dismissed" }) };
  });
  try {
    const error = await assertRejects(
      () =>
        methods.dismiss_code_scanning_alerts.execute(
          bulkArgs,
          context as never,
        ),
      Error,
      "#10: spawn exploded",
    );
    assert(error.message.includes("2 dismissed and recorded"));
    assertEquals(getWrittenResources().length, 2);
  } finally {
    gh.restore();
  }
});

Deno.test("idempotency keys exclude characters that are invalid in Windows file names", () => {
  const schema = methods.reopen_code_scanning_alert.arguments;
  const parse = (idempotencyKey: string) =>
    schema.safeParse({ repo: REPO, number: 1, idempotencyKey }).success;
  assert(parse("dismiss-42"));
  assert(parse("run_2026.11.06"));
  assertEquals(parse("dismiss:42"), false);
  assertEquals(parse("trailing."), false);
  assertEquals(parse("a b"), false);
  assertEquals(parse("a~b"), false); // "~" separates name parts
  assertEquals(parse(""), false);
});

Deno.test("a repo whose name imitates another kind of instance cannot collide with it", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh((argv) =>
    argv.includes("PATCH")
      ? { stdout: rawAlert(3, { state: "dismissed" }) }
      : { stdout: [] }
  );
  try {
    // Repo "a/b-dismiss-3" writes its summary; repo "a/b" then dismisses #3
    // under the key "summary". With "-" separators these were the same name.
    await methods.list_code_scanning_alerts.execute(
      { repo: "a/b-dismiss-3", maxAlerts: 1000 },
      context as never,
    );
    await methods.dismiss_code_scanning_alert.execute(
      {
        repo: "a/b",
        number: 3,
        reason: "wont_fix",
        comment: "c",
        idempotencyKey: "summary",
      },
      context as never,
    );
    assertEquals(gh.calls.filter((c) => c.includes("PATCH")).length, 1);
    const names = getWrittenResources().map((w) => w.name);
    assertEquals(new Set(names).size, names.length, names.join(", "));
  } finally {
    gh.restore();
  }
});

Deno.test("a pass that skipped an alert is not trusted, and its stored instance survives the prune", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context, getWrittenResources } = harness;
  const { deleted } = withStore(harness);
  const name5 = `${encodeURIComponent(REPO)}~alert~5`;
  await context.writeResource("codeScanningAlert", name5, {
    repo: REPO,
    number: 5,
  });
  const full = [rawAlert(7), rawAlert(6), rawAlert(5), rawAlert(4)];
  // Pass 1: alert 5 fell off the page boundary while the list shifted.
  const gh = mockGh((_argv, call) => ({
    stdout: call === 1 ? [rawAlert(7), rawAlert(6), rawAlert(4)] : full,
  }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    assertEquals(gh.calls.length, 3); // pass 1 differed, passes 2 and 3 agreed
    const summary = getWrittenResources().at(-1)!.data as {
      alertNumbers: number[];
    };
    assertEquals(summary.alertNumbers, [7, 6, 5, 4]);
    assertEquals(deleted, []); // 5 was never wrongly pruned
  } finally {
    gh.restore();
  }
});

Deno.test("a list that never settles writes nothing and deletes nothing", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context } = harness;
  const { deleted } = withStore(harness);
  const gh = mockGh((_argv, call) => ({
    stdout: Array.from({ length: call }, (_, i) => rawAlert(i + 1)),
  }));
  try {
    await context.writeResource(
      "codeScanningAlert",
      `${encodeURIComponent(REPO)}~alert~99`,
      { repo: REPO, number: 99 },
    );
    const before = harness.getWrittenResources().length;
    await assertRejects(
      () =>
        methods.list_code_scanning_alerts.execute(
          { repo: REPO, maxAlerts: 1000 },
          context as never,
        ),
      Error,
      "kept changing across 3 reads",
    );
    assertEquals(harness.getWrittenResources().length, before);
    assertEquals(deleted, []);
  } finally {
    gh.restore();
  }
});

Deno.test("list is truncated when the page cap ends the read on a full page", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  // Every page repeats the same 100 rows, so unique rows never pass maxAlerts
  // but the cap (11 pages) still ends the read with more pages available.
  const same = Array.from({ length: 100 }, (_, i) => rawAlert(100 - i));
  const gh = mockGh(() => ({ stdout: same }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: REPO, maxAlerts: 1000 },
      context as never,
    );
    const summary = getWrittenResources().at(-1)!.data as {
      total: number;
      truncated: boolean;
    };
    assertEquals(summary.total, 100);
    assertEquals(summary.truncated, true);
    assertEquals(gh.calls.length, 22); // two stable passes of 11 pages
  } finally {
    gh.restore();
  }
});

Deno.test("reusing an idempotency key with a different reason or comment is refused", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh(patchResponder());
  try {
    const first = {
      repo: REPO,
      number: 10,
      reason: "used_in_tests" as const,
      comment: "Test fixture",
      idempotencyKey: "reuse-1",
    };
    await methods.dismiss_code_scanning_alert.execute(first, context as never);
    for (
      const changed of [
        { ...first, comment: "A different rationale" },
        { ...first, reason: "wont_fix" as const },
      ]
    ) {
      await assertRejects(
        () =>
          methods.dismiss_code_scanning_alert.execute(
            changed,
            context as never,
          ),
        Error,
        'idempotencyKey "reuse-1" was already used for alert #10 with a different reason or comment',
      );
    }
    assertEquals(gh.calls.length, 1);
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss pauses between real requests but not past skipped alerts", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh(patchResponder());
  try {
    const args = { ...bulkArgs, pauseMs: 150 };
    let start = performance.now();
    await methods.dismiss_code_scanning_alerts.execute(args, context as never);
    // Three real PATCHes: a pause after the first and second, none after the last.
    assert(performance.now() - start >= 280, "expected two pauses");
    start = performance.now();
    await methods.dismiss_code_scanning_alerts.execute(args, context as never);
    assertEquals(gh.calls.length, 3); // the rerun skipped all three
    assert(performance.now() - start < 150, "skipped alerts must not pause");
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss stops on an authorization failure instead of repeating it", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  const gh = mockGh(() => ({
    success: false,
    stderr: "gh: Bad credentials (HTTP 401)",
  }));
  try {
    await assertRejects(
      () =>
        methods.dismiss_code_scanning_alerts.execute(
          bulkArgs,
          context as never,
        ),
      Error,
      "not attempted because GitHub rejected the credentials or permissions: #11, #12",
    );
    assertEquals(gh.calls.length, 1);
    assertEquals(getWrittenResources().length, 0);
  } finally {
    gh.restore();
  }
});

Deno.test("bulk dismiss does not stop for a per-alert failure such as a missing alert", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh((argv) => {
    const n = Number(
      argv.find((a) => a.includes("/alerts/"))?.split("/").pop(),
    );
    return n === 10
      ? { success: false, stderr: "gh: Not Found (HTTP 404)" }
      : { stdout: rawAlert(n, { state: "dismissed" }) };
  });
  try {
    await assertRejects(
      () =>
        methods.dismiss_code_scanning_alerts.execute(
          bulkArgs,
          context as never,
        ),
      Error,
      "2 dismissed and recorded",
    );
    assertEquals(gh.calls.length, 3);
  } finally {
    gh.restore();
  }
});

Deno.test("idempotency keys are capped so a marker name can never exceed a file name limit", () => {
  const schema = methods.reopen_code_scanning_alert.arguments;
  const parse = (idempotencyKey: string) =>
    schema.safeParse({ repo: REPO, number: 1, idempotencyKey }).success;
  assert(parse("k".repeat(64)));
  assertEquals(parse("k".repeat(65)), false);
  // Longest legitimate marker name stays far below the 255-byte limit.
  const longestRepo = `${"o".repeat(39)}/${"r".repeat(100)}`;
  const name = `${encodeURIComponent(longestRepo)}~dismiss~999999~${
    "k".repeat(64)
  }`;
  assert(new TextEncoder().encode(name).length < 255, String(name.length));
});

Deno.test("owner/name case does not split a repo's instances or defeat the prune", async () => {
  const harness = createModelTestContext({ globalArgs: {} });
  const { context } = harness;
  const { deleted } = withStore(harness);
  let snapshot = [rawAlert(2), rawAlert(1)];
  const gh = mockGh(() => ({ stdout: snapshot }));
  try {
    await methods.list_code_scanning_alerts.execute(
      { repo: "Webframp/Swamp-Extensions", maxAlerts: 1000 },
      context as never,
    );
    snapshot = [rawAlert(1)];
    await methods.list_code_scanning_alerts.execute(
      { repo: "webframp/swamp-extensions", maxAlerts: 1000 },
      context as never,
    );
    // Alert 2 belonged to the same repo under a different spelling.
    assertEquals(deleted, [`${encodeURIComponent(REPO)}~alert~2`]);
    const names = harness.getWrittenResources().map((w) => w.name);
    assertEquals(
      names.every((n) => n.startsWith(`${encodeURIComponent(REPO)}~`)),
      true,
      names.join(", "),
    );
  } finally {
    gh.restore();
  }
});

Deno.test("a differently cased repo reuses the same dismissal marker", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const gh = mockGh(patchResponder());
  try {
    const args = {
      number: 10,
      reason: "used_in_tests" as const,
      comment: "Test fixture",
      idempotencyKey: "case-1",
    };
    await methods.dismiss_code_scanning_alert.execute(
      { ...args, repo: "Webframp/Swamp-Extensions" },
      context as never,
    );
    await methods.dismiss_code_scanning_alert.execute(
      { ...args, repo: "webframp/swamp-extensions" },
      context as never,
    );
    assertEquals(gh.calls.length, 1);
  } finally {
    gh.restore();
  }
});
