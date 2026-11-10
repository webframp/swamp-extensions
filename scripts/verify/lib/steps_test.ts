import { assert, assertEquals } from "@std/assert";
import {
  fileStem,
  judgeQuality,
  pool,
  runExtensionTasks,
  runRecorded,
} from "./steps.ts";
import type { StepRecord } from "./types.ts";

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "verify-steps-" });
}

Deno.test("a passing command is recorded as passed with its log", async () => {
  const out = await tmp();
  try {
    const r = await runRecorded(out, {
      name: "ok",
      cmd: ["sh", "-c", "echo hello"],
      cwd: out,
    });
    assertEquals(r.status, "passed");
    assertEquals(r.exitCode, 0);
    assertEquals(
      (await Deno.readTextFile(`${out}/logs/${fileStem("ok")}.log`)).trim(),
      "hello",
    );
    const rec = JSON.parse(
      await Deno.readTextFile(`${out}/steps/${fileStem("ok")}.json`),
    ) as StepRecord;
    assertEquals(rec.name, "ok");
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("a failing command is recorded as failed with its exit code", async () => {
  const out = await tmp();
  try {
    const r = await runRecorded(out, {
      name: "bad",
      cmd: ["sh", "-c", "echo nope >&2; exit 3"],
      cwd: out,
    });
    assertEquals(r.status, "failed");
    assertEquals(r.exitCode, 3);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("a command that cannot start is a failure, not a skip", async () => {
  const out = await tmp();
  try {
    const r = await runRecorded(out, {
      name: "missing",
      cmd: ["definitely-not-a-real-binary-xyz"],
      cwd: out,
    });
    assertEquals(r.status, "failed");
    assertEquals(r.exitCode, null);
    assert(r.reason?.includes("could not run"));
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("a judge can fail a command that exited zero", async () => {
  const out = await tmp();
  try {
    const r = await runRecorded(out, {
      name: "judged",
      cmd: ["sh", "-c", 'echo \'{"status":"failed"}\''],
      cwd: out,
      judge: judgeQuality,
    });
    assertEquals(r.status, "failed");
    assertEquals(r.exitCode, 0);
    assert(r.reason?.includes("status"));
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("quality passes at 100, or at 100 once provisional factors are earned", () => {
  assertEquals(judgeQuality('{"status":"passed","percentage":100}'), null);
  // The 87% shape a compliant extension reports before publish.
  assertEquals(
    judgeQuality(
      '{"status":"passed","percentage":87,"ifProvisionalEarned":{"percentage":100},"allPassed":true}',
    ),
    null,
  );
});

Deno.test("quality fails below 100, on a failed status, or on allPassed false", () => {
  assert(judgeQuality('{"status":"passed","percentage":80}'));
  assert(
    judgeQuality(
      '{"status":"passed","percentage":87,"ifProvisionalEarned":{"percentage":93}}',
    ),
  );
  assert(judgeQuality('{"status":"failed","percentage":100}'));
  assert(
    judgeQuality('{"status":"passed","percentage":100,"allPassed":false}'),
  );
  assert(judgeQuality("<html>503</html>"));
});

Deno.test("a missing allPassed does not fail an otherwise perfect score", () => {
  assertEquals(judgeQuality('{"status":"passed","percentage":100}'), null);
});

Deno.test("step file stems do not collide for similar names", () => {
  const names = ["a/b:lint", "a_b:lint", "a:b:lint", "a/b_lint", "a=b"];
  assertEquals(new Set(names.map(fileStem)).size, names.length);
});

Deno.test("pool keeps results in input order and honours the limit", async () => {
  let running = 0;
  let peak = 0;
  const jobs = [30, 5, 20, 1, 10].map((ms, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return i;
  });
  assertEquals(await pool(jobs, 2), [0, 1, 2, 3, 4]);
  assert(peak <= 2);
});

Deno.test("extension tasks run in each extension directory and are all recorded", async () => {
  const root = await tmp();
  const out = await tmp();
  try {
    for (const [ext, failTest] of [["good", false], ["bad", true]] as const) {
      await Deno.mkdir(`${root}/${ext}`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/${ext}/deno.json`,
        JSON.stringify({
          tasks: {
            check: "exit 0",
            lint: "exit 0",
            "fmt:check": "exit 0",
            test: failTest ? "exit 1" : "exit 0",
          },
        }),
      );
    }
    const recs = await runExtensionTasks(out, root, ["good", "bad"], 2);
    assertEquals(recs.length, 8);
    const byName = new Map(recs.map((r) => [r.name, r.status]));
    assertEquals(byName.get("good:test"), "passed");
    assertEquals(byName.get("bad:test"), "failed");
    assertEquals(byName.get("bad:lint"), "passed");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("an extension with no such task fails rather than passing", async () => {
  const root = await tmp();
  const out = await tmp();
  try {
    await Deno.mkdir(`${root}/ext`);
    await Deno.writeTextFile(
      `${root}/ext/deno.json`,
      JSON.stringify({ tasks: { check: "exit 0" } }),
    );
    const recs = await runExtensionTasks(out, root, ["ext"], 2);
    assertEquals(recs.find((r) => r.name === "ext:test")?.status, "failed");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(out, { recursive: true });
  }
});
