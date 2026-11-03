import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  argFields,
  assertSensitiveOperationsExist,
  bodyShape,
  type ClassifiedMethod,
  classifyOperation,
  classifyServiceMethods,
  generateMethodName,
  generateModelSource,
  sensitiveArgFields,
  sensitiveFieldsForResource,
} from "./method_classifier.ts";
import { type GroupedOperation, groupOperations } from "./service_grouper.ts";
import { generateApiLib } from "./extension_generator.ts";
import { SERVICES } from "../config.ts";
import { loadSpec } from "./spec_fixture.ts";

const groups = groupOperations(loadSpec(), SERVICES);
const allMethods: ClassifiedMethod[] = groups.flatMap((g) =>
  classifyServiceMethods(g)
);
const byId = Object.fromEntries(
  allMethods.map((m) => [m.operation.operationId, m]),
);

/** A bare operation for the classification rules. */
function op(
  operationId: string,
  httpMethod: string,
  paginated = false,
): GroupedOperation {
  return {
    operationId,
    httpMethod,
    path: "/x",
    pagination: { paginated, resultsPath: ["data"], keep: [] },
  } as unknown as GroupedOperation;
}

Deno.test("classifyOperation: the 110 operations split 19 / 31 / 11 / 4 / 12 / 33", () => {
  const counts: Record<string, number> = {};
  for (const m of allMethods) counts[m.type] = (counts[m.type] ?? 0) + 1;
  assertEquals(allMethods.length, 110);
  assertEquals(counts, {
    list: 19,
    get: 31,
    create: 11,
    update: 4,
    delete: 12,
    action: 33,
  });
});

Deno.test("classifyOperation: eight DELETE operations are actions, not deletions", () => {
  const deleteActions = allMethods
    .filter((m) => m.operation.httpMethod === "delete" && m.type === "action")
    .map((m) => m.operation.operationId)
    .sort();
  assertEquals(deleteActions, [
    "changeDomainDelegationFromVanity",
    "deactivateZoneService",
    "disableDomainAutoRenewal",
    "disableDomainDnssec",
    "disableDomainTransferLock",
    "disableVanityNameServers",
    "disableWhoisPrivacy",
    "unapplyServiceFromDomain",
  ]);
  // And the PUT-based enable is an action too.
  assertEquals(byId.enableDomainAutoRenewal.type, "action");
  assertEquals(byId.enableDomainAutoRenewal.operation.httpMethod, "put");
});

Deno.test("classifyOperation: the verb rules by HTTP method", () => {
  assertEquals(classifyOperation(op("listThings", "get")), "list");
  assertEquals(classifyOperation(op("queryThings", "get", true)), "list");
  assertEquals(classifyOperation(op("getThing", "get")), "get");
  assertEquals(classifyOperation(op("checkThing", "get")), "get");
  assertEquals(classifyOperation(op("checkThing", "post")), "action");
  assertEquals(classifyOperation(op("createThing", "post")), "create");
  assertEquals(classifyOperation(op("anything", "patch")), "update");
  assertEquals(classifyOperation(op("updateThing", "put")), "update");
  assertEquals(classifyOperation(op("enableThing", "put")), "action");
  assertEquals(classifyOperation(op("deleteThing", "delete")), "delete");
  assertEquals(classifyOperation(op("cancelThing", "delete")), "delete");
  assertEquals(classifyOperation(op("disableThing", "delete")), "action");
});

Deno.test("classifyOperation: an unclassified verb fails generation", () => {
  assertThrows(
    () => classifyOperation(op("frobnicateThing", "post")),
    Error,
    'frobnicateThing (POST /x): no classification rule matches the verb "frobnicate"',
  );
  // A DELETE or POST that shares a verb with the wrong method is not guessed at.
  assertThrows(() => classifyOperation(op("createThing", "put")), Error);
  assertThrows(() => classifyOperation(op("removeThing", "post")), Error);
});

Deno.test("classifyServiceMethods: reports every unclassifiable operation at once", () => {
  const group = {
    config: SERVICES[0],
    operations: [op("frobA", "post"), op("frobB", "post")],
  };
  assertThrows(
    () => classifyServiceMethods(group as never),
    Error,
    "frobA",
  );
  assertThrows(
    () => classifyServiceMethods(group as never),
    Error,
    "frobB",
  );
});

Deno.test("generateMethodName: the operationId in snake case", () => {
  assertEquals(
    generateMethodName(op("listZoneRecords", "get")),
    "list_zone_records",
  );
  assertEquals(generateMethodName(op("whoami", "get")), "whoami");
  assertEquals(
    generateMethodName(op("purchaseRenewalLetsencryptCertificate", "post")),
    "purchase_renewal_letsencrypt_certificate",
  );
});

Deno.test("resources: a check or action never shares a resource with the plain getter", () => {
  assertEquals(byId.getDomain.resource, "domain");
  assertEquals(byId.checkDomain.resource, "check_domain");
  assertEquals(byId.getDomainDnssec.resource, "domain_dnssec");
  assertEquals(byId.enableDomainDnssec.resource, "enable_domain_dnssec");
  assertEquals(byId.deleteZoneRecord.resource, undefined);
  assertEquals(byId.deleteZoneRecord.resultKind, "none");
});

Deno.test("resources: create, get and update of one noun share a resource", () => {
  assertEquals(byId.createZoneRecord.resource, "zone_record");
  assertEquals(byId.getZoneRecord.resource, "zone_record");
  assertEquals(byId.updateZoneRecord.resource, "zone_record");
  assertEquals(byId.listZoneRecords.resource, "zone_records");
});

Deno.test("resources: two methods of one resource name with different schemas are split", () => {
  const group = groups.find((g) => g.config.name === "zones")!;
  const getZone = group.operations.find((o) => o.operationId === "getZone")!;
  const other = {
    ...getZone,
    operationId: "updateZone",
    httpMethod: "patch",
    responseSchema: {
      type: "object",
      properties: { different: { type: "string" } },
    },
  };
  const methods = classifyServiceMethods({
    config: group.config,
    operations: [getZone, other as GroupedOperation],
  });
  assertEquals(methods.map((m) => m.resource), ["zone", "update_zone"]);
});

Deno.test("result kinds: lists, objects and no-body responses", () => {
  assertEquals(byId.listZoneRecords.resultKind, "list");
  assertEquals(byId.getDomainDelegation.resultKind, "list"); // array data, one request
  assertEquals(byId.getZone.resultKind, "object");
  assertEquals(byId.disableDomainDnssec.resultKind, "receipt");
  assertEquals(byId.deleteRegistrantChange.resultKind, "object-or-receipt");
});

Deno.test("describe strings: only billable operations open with Billable:", () => {
  const billable = allMethods
    .filter((m) => m.description.startsWith("Billable:"))
    .map((m) => m.operation.operationId)
    .sort();
  assertEquals(billable, [
    "purchaseLetsencryptCertificate",
    "purchaseRenewalLetsencryptCertificate",
    "registerDomain",
    "renewDomain",
    "restoreDomain",
    "transferDomain",
  ]);
});

Deno.test("assertSensitiveOperationsExist: passes for the configured operations", () => {
  assertSensitiveOperationsExist(loadSpec());
});

Deno.test("assertSensitiveOperationsExist: an operation missing from the spec fails generation", () => {
  assertThrows(
    () =>
      assertSensitiveOperationsExist(loadSpec(), {
        response: { renamedUpstream: ["secret"] },
      }),
    Error,
    "SENSITIVE_RESPONSE_FIELDS names operation(s) not in the spec: renamedUpstream",
  );
  assertThrows(
    () => assertSensitiveOperationsExist(loadSpec(), { args: { nope: ["x"] } }),
    Error,
    "SENSITIVE_ARG_FIELDS",
  );
  assertThrows(
    () => assertSensitiveOperationsExist(loadSpec(), { billable: ["nope"] }),
    Error,
    "BILLABLE_OPERATIONS",
  );
});

Deno.test("sensitiveFieldsForResource: a field the schema lacks fails generation", () => {
  const m = byId.getCertificatePrivateKey;
  assertEquals(sensitiveFieldsForResource(m, [m]), ["private_key"]);
  assertThrows(
    () =>
      sensitiveFieldsForResource(m, [m], {
        getCertificatePrivateKey: ["not_a_field"],
      }),
    Error,
    "not_a_field are not declared in the response schema",
  );
  // A list resource cannot carry a vaulted field inside items.
  const list = byId.listZoneRecords;
  assertThrows(
    () => sensitiveFieldsForResource(list, [list], { listZoneRecords: ["x"] }),
    Error,
    "only supported on single-object resources",
  );
});

Deno.test("sensitiveArgFields: a field the request body lacks fails generation", () => {
  assertEquals(sensitiveArgFields(byId.transferDomain.operation), [
    "auth_code",
  ]);
  assertThrows(
    () =>
      sensitiveArgFields(byId.transferDomain.operation, {
        transferDomain: ["not_a_field"],
      }),
    Error,
    "not_a_field are not declared in the request body schema",
  );
});

Deno.test("sensitive fields: found by operation, not by name", () => {
  // ServiceSetting.password is a boolean flag and DelegationSigner.public_key
  // is a public value; a name heuristic would flag both.
  const text = JSON.stringify(loadSpec());
  assertEquals(/"password"/.test(text), true);
  assertEquals(/"public_key"/.test(text), true);
  const model = (name: string) =>
    generateModelSource(
      groups.find((g) => g.config.name === name)!,
      allMethods.filter((m) =>
        groups.find((g) => g.config.name === name)!
          .operations.includes(m.operation)
      ),
      "2026.01.01.1",
    );
  // Every model marks its apiToken global argument; only the configured
  // response field adds a second marker.
  const markers = (name: string) =>
    [...model(name).matchAll(/sensitive: true/g)].length;
  assertMatch(
    model("certificates"),
    /private_key[^\n]*\n?[^\n]*sensitive: true/,
  );
  assertEquals(markers("certificates"), 2);
  assertEquals(markers("dnssec"), 1);
  assertEquals(markers("domains"), 1);
});

Deno.test("argFields: transferDomain marks auth_code sensitive and keeps path arguments", () => {
  const fields = argFields(byId.transferDomain);
  assertEquals(fields.find((f) => f.name === "domain")!.origin, "path");
  const auth = fields.find((f) => f.name === "auth_code")!;
  assertStringIncludes(auth.zod, ".meta({ sensitive: true })");
  assertEquals(
    fields.some((f) => f.name === "account"),
    false,
  );
});

Deno.test("argFields: integer path ids accept a string or a number", () => {
  const record = argFields(byId.getZoneRecord);
  assertMatch(record.find((f) => f.name === "zone")!.zod, /^z\.string\(\)/);
  assertMatch(
    record.find((f) => f.name === "zonerecord")!.zod,
    /^z\.union\(\[z\.string\(\), z\.number\(\)\.int\(\)\]\)/,
  );
});

Deno.test("argFields: a name claimed by two origins fails generation", () => {
  const m = structuredClone(byId.createZoneRecord);
  m.operation.queryParams = [
    { name: "name", in: "query", schema: { type: "string" } },
  ];
  assertThrows(
    () => argFields(m),
    Error,
    'body argument "name" collides with a query argument',
  );
});

Deno.test("bodyShape: every request body shape in the spec is supported", () => {
  const shapes = new Set(
    allMethods.map((m) => bodyShape(m.operation)).filter(Boolean),
  );
  assertEquals([...shapes].sort(), ["array", "properties", "record", "union"]);
  assertEquals(bodyShape(byId.updateZoneNsRecords.operation), "union");
  assertEquals(bodyShape(byId.changeDomainDelegation.operation), "array");
  assertEquals(bodyShape(byId.applyServiceToDomain.operation), "record");
  assertEquals(bodyShape(byId.deleteZoneRecord.operation), undefined);
});

Deno.test("bodyShape: an unsupported shape fails generation", () => {
  const bad = { operationId: "x", requestBody: { type: "string" } };
  assertThrows(
    () => bodyShape(bad as unknown as GroupedOperation),
    Error,
    "unsupported request body shape",
  );
});

Deno.test("generated source: a list names its instance from its parent, so two zones never collide", () => {
  const source = generateModelSource(
    groups.find((g) => g.config.name === "zones")!,
    classifyServiceMethods(groups.find((g) => g.config.name === "zones")!),
    "2026.01.01.1",
  );
  assertStringIncludes(
    source,
    'writeResource("zone_records", sanitizeInstanceName(String(args.zone))',
  );
  assertStringIncludes(source, 'writeResource("zones", "main"');
});

Deno.test({
  name:
    "generated model: list_zone_records writes a distinct instance per zone and honors accountId",
  sanitizeResources: false,
  fn: async () => {
    const zones = groups.find((g) => g.config.name === "zones")!;
    const methods = classifyServiceMethods(zones);
    const dir = await Deno.makeTempDir();
    const originalFetch = globalThis.fetch;
    try {
      await Deno.mkdir(join(dir, "_lib"));
      await Deno.writeTextFile(join(dir, "_lib", "api.ts"), generateApiLib());
      await Deno.writeTextFile(
        join(dir, "zones.ts"),
        generateModelSource(zones, methods, "2026.01.01.1"),
      );
      const { model } = await import(`file://${join(dir, "zones.ts")}`);

      const requested: string[] = [];
      globalThis.fetch = (input) => {
        requested.push(String(input));
        return Promise.resolve(
          Response.json({
            data: [{ id: 1 }],
            pagination: {
              current_page: 1,
              per_page: 100,
              total_entries: 1,
              total_pages: 1,
            },
          }),
        );
      };

      const written: { spec: string; instance: string; data: unknown }[] = [];
      const context = {
        globalArgs: { apiToken: "t", accountId: "42", environment: "sandbox" },
        writeResource: (spec: string, instance: string, data: unknown) => {
          written.push({ spec, instance, data });
          return Promise.resolve({ name: instance });
        },
        logger: { info: () => {} },
      };
      for (const zone of ["example.com", "example.org"]) {
        await model.methods.list_zone_records.execute({ zone }, context);
      }
      assertEquals(written.map((w) => [w.spec, w.instance]), [
        ["zone_records", "example.com"],
        ["zone_records", "example.org"],
      ]);
      assertMatch(
        requested[0],
        /^https:\/\/api\.sandbox\.dnsimple\.com\/v2\/42\/zones\/example\.com\/records\?/,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Deno.remove(dir, { recursive: true });
    }
  },
});
