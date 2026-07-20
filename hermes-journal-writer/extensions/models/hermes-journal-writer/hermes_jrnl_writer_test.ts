// Hermes Journal Writer - Tests
// SPDX-License-Identifier: Apache-2.0
// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@1.0.19";
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

/** A mockDenoCommand handler that returns one HN story for `data get` and
 * succeeds for every git command. */
function mockWithHnData(cmd: string[]): { stdout: string; success: boolean } {
  if (cmd.includes("data") && cmd.includes("get")) {
    return {
      stdout: JSON.stringify({
        content: JSON.stringify({
          hnFrontPage: {
            stories: [{ title: "Test", score: 10, by: "user", url: "u" }],
          },
        }),
      }),
      success: true,
    };
  }
  // git status reports the day's file staged, so a commit (and push) happens.
  if (cmd.includes("status")) {
    return { stdout: " A journal/x.org", success: true };
  }
  return { stdout: "", success: true };
}

Deno.test("write_daily_entry creates new file when none exists", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand(mockWithHnData);
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

Deno.test("write_daily_entry skips (no file, no commit) when there is no data", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    // No research data available.
    if (cmd.includes("data") && cmd.includes("get")) {
      return { stdout: "", success: false };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    // No file written — a later run today can still create the real entry.
    assertEquals(Object.keys(files).length, 0);
    assertEquals(
      (getWrittenResources()[0].data as any).status,
      "skipped-no-data",
    );
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry skips when entry already exists", async () => {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const lowerDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const orgDate = `${year}-${month}-${day} ${lowerDays[now.getDay()]}`;
  // Per-day file: the code stats YYYY-MM-DD-dow.org, so mock exactly that path.
  const filePath = `/tmp/test-org/journal/${year}-${month}-${day}-${
    lowerDays[now.getDay()]
  }.org`;
  const files: Record<string, string> = {
    [filePath]: `#+TITLE: Research Journal ${orgDate}\n\nExisting content`,
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
  // Needs data so a file is actually written (tilde expansion is what we check).
  const restoreCmd = mockDenoCommand(mockWithHnData);
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
    if (cmd.includes("status")) {
      return { stdout: " A journal/x.org", success: true };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    const writtenFile = Object.keys(files)[0];
    // Per-day file: the entry IS the whole document, so sections are level-1 (`* `).
    assertEquals(files[writtenFile].includes("* Hacker News"), true);
    // Verify no nested headings (would be "** X" or deeper at line start).
    assertEquals(/^\*\*+ \w/m.test(files[writtenFile]), false);
    assertEquals((getWrittenResources()[0].data as any).status, "written");
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry never emits a doubled colon in FILETAGS from empty-sanitizing tags", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    if (cmd.includes("data") && cmd.includes("get")) {
      return {
        stdout: JSON.stringify({
          content: JSON.stringify({
            // tags that sanitize to "" ("!!!" and "@@@") must be dropped,
            // not rendered as an extra `::` pair in #+FILETAGS.
            lobstersHottest: {
              stories: [{
                title: "T",
                score: 1,
                url: "x",
                tags: ["!!!", "go"],
              }],
            },
            arxiv: {
              entries: [{ title: "A", link: "l", category: "@@@" }],
            },
          }),
        }),
        success: true,
      };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context } = createModelTestContext({ globalArgs: TEST_ARGS });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    const content = files[Object.keys(files)[0]];
    const filetagsLine = content.split("\n").find((l) =>
      l.startsWith("#+FILETAGS:")
    )!;
    assertEquals(filetagsLine.includes("::"), false);
    // The valid tag survived.
    assertEquals(filetagsLine.includes(":go:"), true);
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry rethrows non-NotFound stat errors", async () => {
  const files: Record<string, string> = {};
  const origMkdir = Deno.mkdir;
  const origStat = Deno.stat;
  (Deno as any).mkdir = () => Promise.resolve();
  (Deno as any).stat = () =>
    Promise.reject(new Deno.errors.PermissionDenied("denied"));
  const restoreCmd = mockDenoCommand(() => ({ stdout: "", success: false }));
  try {
    const { context } = createModelTestContext({ globalArgs: TEST_ARGS });
    await assertRejects(
      () => model.methods.write_daily_entry.execute({} as any, context as any),
      Deno.errors.PermissionDenied,
    );
    // The write must not have happened — the error surfaced instead of being masked.
    assertEquals(Object.keys(files).length, 0);
  } finally {
    (Deno as any).mkdir = origMkdir;
    (Deno as any).stat = origStat;
    restoreCmd();
  }
});

Deno.test("write_daily_entry records committed-not-pushed when the push fails", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  const restoreCmd = mockDenoCommand((cmd) => {
    // Data is present so we reach the commit/push path.
    if (cmd.includes("data") && cmd.includes("get")) {
      return {
        stdout: JSON.stringify({
          content: JSON.stringify({
            hnFrontPage: {
              stories: [{ title: "T", score: 1, by: "u", url: "u" }],
            },
          }),
        }),
        success: true,
      };
    }
    // A push that fails must NOT be reported as a successful write.
    if (cmd.includes("push")) return { stdout: "", success: false };
    // Something is staged, so a commit happens.
    if (cmd.includes("status")) {
      return { stdout: " M journal/x.org", success: true };
    }
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    assertEquals(
      (getWrittenResources()[0].data as any).status,
      "committed-not-pushed",
    );
    // The file was still written locally.
    assertEquals(Object.keys(files).length, 1);
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry does not push when there is nothing to commit", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  let pushed = false;
  const restoreCmd = mockDenoCommand((cmd) => {
    if (cmd.includes("data") && cmd.includes("get")) {
      return {
        stdout: JSON.stringify({
          content: JSON.stringify({
            hnFrontPage: {
              stories: [{ title: "T", score: 1, by: "u", url: "u" }],
            },
          }),
        }),
        success: true,
      };
    }
    if (cmd.includes("push")) {
      pushed = true;
      return { stdout: "", success: true };
    }
    // git status reports no staged changes → nothing to commit.
    if (cmd.includes("status")) return { stdout: "", success: true };
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    await model.methods.write_daily_entry.execute({} as any, context as any);
    assertEquals(
      (getWrittenResources()[0].data as any).status,
      "written-nothing-to-commit",
    );
    // No commit was made, so no push should advance the remote.
    assertEquals(pushed, false);
  } finally {
    restoreFs();
    restoreCmd();
  }
});

Deno.test("write_daily_entry treats a failed git status as an error, not nothing-to-commit", async () => {
  const files: Record<string, string> = {};
  const restoreFs = mockFs(files);
  let pushed = false;
  const restoreCmd = mockDenoCommand((cmd) => {
    if (cmd.includes("data") && cmd.includes("get")) {
      return {
        stdout: JSON.stringify({
          content: JSON.stringify({
            hnFrontPage: {
              stories: [{ title: "T", score: 1, by: "u", url: "u" }],
            },
          }),
        }),
        success: true,
      };
    }
    if (cmd.includes("push")) {
      pushed = true;
      return { stdout: "", success: true };
    }
    // git status fails (e.g. held index.lock): non-zero exit, empty stdout.
    if (cmd.includes("status")) return { stdout: "", success: false };
    return { stdout: "", success: true };
  });
  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: TEST_ARGS,
    });
    // gitCommit throws; the method catches it and records not-committed —
    // it must NOT push or claim a successful write.
    await model.methods.write_daily_entry.execute({} as any, context as any);
    assertEquals(
      (getWrittenResources()[0].data as any).status,
      "written-not-committed",
    );
    assertEquals(pushed, false);
  } finally {
    restoreFs();
    restoreCmd();
  }
});
