import { assertEquals, assertThrows } from "@std/assert";
import { parseFlags } from "./main.ts";

Deno.test("flags with values, bare switches, and a command after --", () => {
  const p = parseFlags([
    "--out",
    "/tmp/o",
    "--strict",
    "--name",
    "n",
    "--",
    "deno",
    "task",
    "--cwd",
    "x",
  ]);
  assertEquals(p.flags.get("out"), "/tmp/o");
  assertEquals(p.flags.get("strict"), true);
  assertEquals(p.flags.get("name"), "n");
  assertEquals(p.rest, ["deno", "task", "--cwd", "x"]);
});

Deno.test("a stray positional argument is an error", () => {
  assertThrows(() => parseFlags(["oops"]), Error, "unexpected argument");
});
