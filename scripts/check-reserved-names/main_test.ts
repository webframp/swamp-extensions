import { assertEquals } from "@std/assert";
import { scanSource } from "./lib/scan.ts";

Deno.test("flags a literal reserved name passed to writeResource", () => {
  const f = scanSource(
    "ext/model.ts",
    `await context.writeResource("zones", "latest", data);`,
  );
  assertEquals(f.length, 1);
  assertEquals(f[0].line, 1);
});

Deno.test("flags a multi-line writeResource call and reports its line", () => {
  const src = [
    "const h = await context.writeResource(",
    '  "compliance",',
    '  "latest",',
    "  {},",
    ");",
  ].join("\n");
  const f = scanSource("ext/model.ts", src);
  assertEquals(f.length, 1);
  assertEquals(f[0].line, 1);
});

Deno.test("flags readResource and writeFile of a reserved name", () => {
  assertEquals(
    scanSource("a.ts", `await context.readResource("latest");`).length,
    1,
  );
  assertEquals(
    scanSource("a.ts", `await context.writeFile("spec", 'latest', b);`).length,
    1,
  );
});

Deno.test("flags the text a generator emits and its instance constant", () => {
  const emitted =
    'const h = await context.writeResource("${resourceName}", "latest", r);';
  assertEquals(scanSource("scripts/x-codegen/lib/c.ts", emitted).length, 1);
  // The pre-fix generators used the constant `'"latest"'` for the instance.
  assertEquals(
    scanSource("scripts/x-codegen/lib/c.ts", `    : '"latest"';`).length,
    1,
  );
  assertEquals(
    scanSource("scripts/x-codegen/lib/c.ts", `const i = "latest";`).length,
    1,
  );
});

Deno.test("ignores comments in generators and non-reserved names", () => {
  assertEquals(
    scanSource("scripts/x-codegen/lib/c.ts", `// the instance "latest" is bad`)
      .length,
    0,
  );
  assertEquals(
    scanSource("ext/model.ts", `writeResource("zones", "zone-scan", d)`).length,
    0,
  );
  assertEquals(
    scanSource("ext/model.ts", `writeResource("zones", id, d)`).length,
    0,
  );
});

Deno.test("does not flag a validator that rejects the reserved name", () => {
  assertEquals(
    scanSource("ext/model.ts", `.refine((n) => n !== "latest", {})`).length,
    0,
  );
});

Deno.test("flags a reserved name in a ternary or ?? fallback, any case", () => {
  assertEquals(
    scanSource("a.ts", `writeResource("s", ok ? "latest" : "x", d)`).length,
    1,
  );
  assertEquals(
    scanSource("a.ts", `writeResource("s", name ?? "latest", d)`).length,
    1,
  );
  assertEquals(
    scanSource("a.ts", `writeResource("s", "Latest", d)`).length,
    1,
  );
  assertEquals(
    scanSource("a.ts", `readResource(name ?? "latest")`).length,
    1,
  );
});

Deno.test("a dot directory above the scan root does not hide files", async () => {
  const base = await Deno.makeTempDir();
  try {
    const root = `${base}/.hidden/repo`;
    await Deno.mkdir(`${root}/ext`, { recursive: true });
    await Deno.mkdir(`${root}/.worktrees/x`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/ext/m.ts`,
      `writeResource("a", "latest", d);`,
    );
    await Deno.writeTextFile(
      `${root}/.worktrees/x/m.ts`,
      `writeResource("a", "latest", d);`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        new URL("./main.ts", import.meta.url).pathname,
        root,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 1);
    assertEquals(text.includes("scanned 1 files, 1 finding(s)"), true, text);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("a scan that finds no files fails instead of passing", async () => {
  const root = await Deno.makeTempDir();
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        new URL("./main.ts", import.meta.url).pathname,
        root,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    assertEquals(out.code, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
