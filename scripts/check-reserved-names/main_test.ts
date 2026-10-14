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
