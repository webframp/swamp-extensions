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
        `${encodeURIComponent(REPO)}-alert-3`,
        `${encodeURIComponent(REPO)}-alert-2`,
        `${encodeURIComponent(REPO)}-alert-1`,
        `${encodeURIComponent(REPO)}-summary`,
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
    assertEquals(gh.calls.length, 1);
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
  const gh = mockGh((_argv, call) => ({ stdout: call === 1 ? page1 : page2 }));
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
    assertEquals(gh.calls.length, 2);
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
      `${encodeURIComponent(REPO)}-alert-detail-42`,
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
      `${encodeURIComponent(REPO)}-dismiss-7-dismiss-7`,
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
      `${encodeURIComponent(REPO)}-reopen-7-reopen-7`,
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
  // The exact membership list GitHub returns in its 422 for an invalid value.
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

Deno.test("a second snapshot prunes alerts the first listed and the second did not", async () => {
  const { context } = createModelTestContext({ globalArgs: {} });
  const deleted: string[] = [];
  (context as unknown as Record<string, unknown>).deleteResource = (
    name: string,
  ) => {
    deleted.push(name);
    return Promise.resolve();
  };
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
    assertEquals(deleted, [`${encodeURIComponent(REPO)}-alert-3`]);
    // Nothing changed: nothing further is pruned.
    await run();
    assertEquals(deleted.length, 1);
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
      name.endsWith("-summary")
        ? "codeScanningSummary"
        : name.includes("-alert-detail-")
        ? "codeScanningAlertDetail"
        : name.includes("-alert-")
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
        `${encodeURIComponent(REPO)}-dismiss-${n}-bulk-a`
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
      "1 of 3 alerts failed (2 dismissed and recorded",
    );
    assert(error.message.includes("#11: "));
    assert(error.message.includes("HTTP 502 for 11"));
    assertEquals(gh.calls.length, 3); // 12 was still attempted after 11 failed
    assertEquals(getWrittenResources().map((w) => w.name), [
      `${encodeURIComponent(REPO)}-dismiss-10-bulk-a`,
      `${encodeURIComponent(REPO)}-dismiss-12-bulk-a`,
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
