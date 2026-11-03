import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildMethodArgs,
  generateTestSource,
  synthesizeValue,
  testPath,
  testQueryParams,
} from "./test_generator.ts";
import { classifyServiceMethods } from "./method_classifier.ts";
import { groupOperations } from "./service_grouper.ts";
import { SERVICES } from "../config.ts";
import { loadSpec } from "./spec_fixture.ts";

const groups = groupOperations(loadSpec(), SERVICES);
const methodsOf = (name: string) =>
  classifyServiceMethods(groups.find((g) => g.config.name === name)!);
const configOf = (name: string) =>
  groups.find((g) => g.config.name === name)!.config;

Deno.test("testPath: the account becomes the test account and other parameters the test id", () => {
  assertEquals(
    testPath("/{account}/zones/{zone}/records/{zonerecord}"),
    "/1010/zones/test-id-123/records/test-id-123",
  );
  assertEquals(testPath("/tlds/{tld}"), "/tlds/test-id-123");
  assertEquals(testPath("/whoami"), "/whoami");
});

Deno.test("synthesizeValue: ignores an object example whose nulls the schema rejects", () => {
  const schema = {
    type: "object",
    example: { public_key: null },
    properties: { public_key: { type: "string" } },
  };
  assertEquals(synthesizeValue(schema), { public_key: "test-value" });
});

Deno.test("synthesizeValue: scalar examples are kept only when the type fits", () => {
  assertEquals(synthesizeValue({ type: "string", example: "x" }), "x");
  assertEquals(synthesizeValue({ type: "integer", example: 7 }), 7);
  assertEquals(synthesizeValue({ type: "integer", example: "7" }), 1);
  assertEquals(synthesizeValue({ type: ["string", "null"] }), "test-value");
  assertEquals(synthesizeValue({ enum: ["a", "b"] }), "a");
  assertEquals(
    synthesizeValue({ anyOf: [{ type: "integer" }, { type: "string" }] }),
    1,
  );
  assertEquals(synthesizeValue({ properties: { a: { type: "boolean" } } }), {
    a: true,
  });
});

Deno.test("buildMethodArgs: path parameters, a body fixture and enum queries", () => {
  const byName = Object.fromEntries(
    methodsOf("zones").map((m) => [m.name, m]),
  );
  const args = buildMethodArgs(byName.create_zone_record);
  assertEquals(args.zone, "test-id-123");
  assertEquals(typeof args.content, "string");

  const analytics = buildMethodArgs(byName.query_dns_analytics);
  assertEquals(analytics.groupings, "date");
  assertEquals(
    testQueryParams(byName.query_dns_analytics).map((q) => q.name).includes(
      "groupings",
    ),
    true,
  );
});

Deno.test("buildMethodArgs: array, union and free-form bodies", () => {
  const registrar = Object.fromEntries(
    methodsOf("registrar").map((m) => [m.name, m]),
  );
  assertEquals(
    Array.isArray(buildMethodArgs(registrar.change_domain_delegation).items),
    true,
  );
  const zones = Object.fromEntries(methodsOf("zones").map((m) => [m.name, m]));
  assertEquals(
    "body" in buildMethodArgs(zones.update_zone_ns_records),
    true,
  );
  const domains = Object.fromEntries(
    methodsOf("domains").map((m) => [m.name, m]),
  );
  assertEquals(
    "body" in buildMethodArgs(domains.apply_service_to_domain),
    true,
  );
});

Deno.test("generateTestSource: covers pages, truncation, the receipt, the account and secrets where they apply", () => {
  const zones = generateTestSource(
    configOf("zones"),
    methodsOf("zones"),
    "zones",
  );
  assertStringIncludes(zones, "walks every page of a list");
  assertStringIncludes(zones, "flags truncation at the page cap");
  assertStringIncludes(zones, "requires accountId");
  assertEquals(zones.includes("swampSensitivePaths"), false);

  const certs = generateTestSource(
    configOf("certificates"),
    methodsOf("certificates"),
    "certificates",
  );
  assertStringIncludes(
    certs,
    "marks private_key sensitive so swamp stores them in a vault",
  );

  const registrar = generateTestSource(
    configOf("registrar"),
    methodsOf("registrar"),
    "registrar",
  );
  assertStringIncludes(
    registrar,
    "marks auth_code sensitive and never writes it",
  );
  assertStringIncludes(registrar, "writes a receipt for a 204");

  // tlds has no account-scoped method: no accountId test, no unused import.
  const tlds = generateTestSource(configOf("tlds"), methodsOf("tlds"), "tlds");
  assertEquals(tlds.includes("requires accountId"), false);
  assertEquals(tlds.includes("assertRejects"), false);
});
