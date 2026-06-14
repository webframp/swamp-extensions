// Hermes Journal Writer - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./hermes_jrnl_writer.ts";

// =============================================================================
// Command & FS Mocks
// =============================================================================

function mockDenoCommand(
  handler: (cmd: string[]) => { stdout: string; success: boolean },
): () => void {
  const original = Deno.Command;
  (Deno as any).Command = class {
    #cmd: string[];
    constructor(bin: string, opts: any) {
      this.#cmd = [bin, ...(opts.args ?? [])];
    }
    output() {
      const result = handler(this.#cmd);
      return Promise.resolve({
        stdout: new TextEncoder().encode(result.stdout),
        stderr: new TextEncoder().encode(""),
        success: result.success,
      });
    }
    spawn() {
      const result = handler(this.#cmd);
      return {
        output: () =>
          Promise.resolve({
            stdout: new TextEncoder().encode(result.stdout),
            stderr: new TextEncoder().encode(""),
            success: result.success,
          }),
        kill: () => {},
      };
    }
  };
  return () => {
    (Deno as any).Command = original;
  };
}

function mockFs(files: Record<string, string>): () => void {
  const origMkdir = Deno.mkdir;
  const origStat = Deno.stat;
  const origWrite = Deno.writeTextFile;
  const origRead = Deno.readTextFile;

  (Deno as any).mkdir = () => Promise.resolve();
  (Deno as any).stat = (path: string) => {
    if (path in files) return Promise.resolve({ isFile: true });
    return Promise.reject(new Deno.errors.NotFound("not found"));
  };
  (Deno as any).writeTextFile = (path: string, content: string) => {
    files[path] = content;
    return Promise.resolve();
  };
  (Deno as any).readTextFile = (path: string) => {
    if (path in files) return Promise.resolve(files[path]);
    return Promise.reject(new Deno.errors.NotFound("not found"));
  };

  return () => {
    (Deno as any).mkdir = origMkdir;
    (Deno as any).stat = origStat;
    (Deno as any).writeTextFile = origWrite;
    (Deno as any).readTextFile = origRead;
  };
}

const TEST_ARGS = {
  orgDir: "/tmp/test-org",
  jrnlSubdir: "journal",
  swampBin: "swamp",
  repoDir: "/tmp/repo",
  gitUserName: "Test Bot",
  gitUserEmail: "bot@test.com",
};

// =============================================================================
// Structure Tests
// =============================================================================

Deno.test("model exports required fields", () => {
  assertEquals(model.type, "@webframp/hermes-journal-writer");
  assertExists(model.version);
  assertExists(model.globalArguments);
  assertExists(model.resources);
  assertExists(model.methods);
});

Deno.test("model has expected methods", () => {
  assertEquals(Object.keys(model.methods), ["write_daily_entry"]);
});

// =============================================================================
// Schema Tests
// =============================================================================

Deno.test("globalArguments has sensible defaults", () => {
  const r = model.globalArguments.safeParse({});
  assertEquals(r.success, true);
  if (r.success) {
    assertEquals(r.data.jrnlSubdir, "journal");
  }
});

Deno.test("globalArguments rejects extra fields (strict)", () => {
  const r = model.globalArguments.safeParse({ extraField: "bad" });
  assertEquals(r.success, false);
});

// =============================================================================
// Execute Tests
// =============================================================================

Deno.test("write_daily_entry creates new file when none exists", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    // swamp data get returns no data
    if (cmd.includes("data") && cmd.includes("get")) {
      return { stdout: "", success: false };
    }
    // git commands succeed
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    const resources = getWrittenResources();
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "journalEntry");
    assertEquals((resources[0].data as any).status, "written");
    // Verify file was created
    const writtenFiles = Object.keys(files);
    assertEquals(writtenFiles.length, 1);
    assertEquals(writtenFiles[0].includes("/tmp/test-org/journal/"), true);
    assertEquals(files[writtenFiles[0]].includes("#+TITLE:"), true);
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry skips when entry already exists", async () => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const orgDate = `${year}-${month}-${String(now.getDate()).padStart(2, "0")} ${
    days[now.getDay()]
  }`;
  const filePath = `/tmp/test-org/journal/${year}-${month}.org`;
  const files: Record<string, string> = {
    [filePath]: `#+TITLE: Test\n\n*** ${orgDate}\nExisting content`,
  };
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    if (cmd.includes("data")) return { stdout: "", success: false };
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    assertEquals(
      (getWrittenResources()[0].data as any).status,
      "already-exists",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rejects path traversal in jrnlSubdir", async () => {
  const restoreFs = mockFs({});
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, jrnlSubdir: "../../etc" },
    });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Error,
      "Invalid jrnlSubdir",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rejects absolute jrnlSubdir", async () => {
  const restoreFs = mockFs({});
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, jrnlSubdir: "/etc/passwd" },
    });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Error,
      "Invalid jrnlSubdir",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rejects invalid git username", async () => {
  const restoreFs = mockFs({});
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, gitUserName: "bad\nuser.name=evil" },
    });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Error,
      "Invalid gitUserName",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rejects invalid git email", async () => {
  const restoreFs = mockFs({});
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, gitUserEmail: "bad\nemail" },
    });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Error,
      "Invalid gitUserEmail",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry expands tilde in orgDir", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  const origEnv = Deno.env.get;
  (Deno.env as any).get = (k: string) =>
    k === "HOME" ? "/home/testuser" : origEnv.call(Deno.env, k);
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, orgDir: "~/org" },
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    const writtenFile = Object.keys(files)[0];
    assertEquals(writtenFile.startsWith("/home/testuser/org/journal/"), true);
    assertEquals(getWrittenResources().length, 1);
  } finally {
    (Deno.env as any).get = origEnv;
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rejects empty jrnlSubdir", async () => {
  const restoreFs = mockFs({});
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({
      globalArgs: { ...TEST_ARGS, jrnlSubdir: "" },
    });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Error,
      "Invalid jrnlSubdir",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry handles research data gracefully", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    if (cmd.includes("data") && cmd.includes("get")) {
      return {
        stdout: JSON.stringify({
          content: JSON.stringify({
            hnFrontPage: {
              stories: [{
                title: "Test",
                score: 10,
                by: "user",
                url: "https://example.com",
              }],
            },
            lobstersHottest: { stories: [] },
            sreWeekly: { items: [] },
            ifin: { topics: [] },
            redmonk: { items: [] },
          }),
        }),
        success: true,
      };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    const writtenFile = Object.keys(files)[0];
    assertEquals(files[writtenFile].includes("**** Hacker News"), true);
    // Verify no bare H2 headings (would be "** X" at line start without leading *)
    assertEquals(/^\*\* \w/m.test(files[writtenFile]), false);
    assertEquals((getWrittenResources()[0].data as any).status, "written");
  } finally {
    restoreFs();
    restoreCmd();
  }
});
