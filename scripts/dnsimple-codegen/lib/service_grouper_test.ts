import { assertEquals, assertThrows } from "@std/assert";
import {
  findService,
  groupOperations,
  withTemplatePlaceholders,
} from "./service_grouper.ts";
import type { OpenAPISpec, ParameterObject } from "./schema_fetcher.ts";
import { type ServiceConfig, SERVICES } from "../config.ts";
import { loadSpec } from "./spec_fixture.ts";

const service = (
  name: string,
  pathPrefixes: string[],
  excludePaths?: string[],
): ServiceConfig => ({
  name,
  description: name,
  pathPrefixes,
  labels: [name],
  excludePaths,
});

/** A spec of bare GET operations, one per path, enough for grouping. */
function specOf(...paths: string[]): OpenAPISpec {
  const out: Record<string, unknown> = {};
  for (const [i, path] of paths.entries()) {
    out[path] = {
      get: {
        operationId: `op${i}`,
        responses: { "204": { description: "ok" } },
      },
    };
  }
  return {
    openapi: "3.1.1",
    info: { title: "t", version: "1" },
    paths: out,
    components: { schemas: {} },
  } as unknown as OpenAPISpec;
}

Deno.test("groupOperations: the eleven services claim 110 operations in the planned split", () => {
  const groups = groupOperations(loadSpec(), SERVICES);
  const counts = Object.fromEntries(
    groups.map((g) => [g.config.name, g.operations.length]),
  );
  assertEquals(counts, {
    "account": 3,
    "zones": 15,
    "secondary-dns": 7,
    "domains": 20,
    "dnssec": 7,
    "certificates": 8,
    "registrar": 28,
    "contacts": 5,
    "templates": 10,
    "webhooks": 4,
    "tlds": 3,
  });
  assertEquals(
    groups.reduce((n, g) => n + g.operations.length, 0),
    110,
  );
});

Deno.test("groupOperations: oauthToken is the one operation left out", () => {
  const ids = groupOperations(loadSpec(), SERVICES)
    .flatMap((g) => g.operations.map((o) => o.operationId));
  assertEquals(ids.includes("oauthToken"), false);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("groupOperations: the double-tagged queryDnsAnalytics lands in exactly one service", () => {
  const claims = groupOperations(loadSpec(), SERVICES).filter((g) =>
    g.operations.some((o) => o.operationId === "queryDnsAnalytics")
  );
  assertEquals(claims.map((g) => g.config.name), ["zones"]);
  const op = claims[0].operations.find((o) =>
    o.operationId === "queryDnsAnalytics"
  )!;
  // Tag grouping would have claimed it for billing as well.
  assertEquals([...op.tags].sort(), ["billing", "zones"]);
});

Deno.test("groupOperations: domains' child prefixes belong to dnssec, certificates and templates", () => {
  const byService = (id: string) =>
    groupOperations(loadSpec(), SERVICES).find((g) =>
      g.operations.some((o) => o.operationId === id)
    )!.config.name;
  assertEquals(byService("getDomain"), "domains");
  assertEquals(byService("getDomainDnssec"), "dnssec");
  assertEquals(byService("listDomainDelegationSignerRecords"), "dnssec");
  assertEquals(byService("getCertificate"), "certificates");
  assertEquals(byService("applyTemplateToDomain"), "templates");
  assertEquals(byService("listServices"), "domains");
  assertEquals(byService("listCharges"), "account");
});

Deno.test("groupOperations: strips {account} per operation and keeps every other path parameter", () => {
  const ops = groupOperations(loadSpec(), SERVICES).flatMap((g) =>
    g.operations
  );
  const byId = Object.fromEntries(ops.map((o) => [o.operationId, o]));

  const records = byId.listZoneRecords;
  assertEquals(records.accountScoped, true);
  assertEquals(records.pathParams.map((p) => p.name), ["zone"]);

  const record = byId.updateZoneRecord;
  assertEquals(record.pathParams.map((p) => p.name), ["zone", "zonerecord"]);

  // `account` and `domains` mix global and account paths.
  assertEquals(byId.whoami.accountScoped, false);
  assertEquals(byId.listAccounts.accountScoped, false);
  assertEquals(byId.listCharges.accountScoped, true);
  assertEquals(byId.getTld.accountScoped, false);
  assertEquals(byId.getTld.pathParams.map((p) => p.name), ["tld"]);
  assertEquals(byId.getService.accountScoped, false);
  assertEquals(byId.getDomain.pathParams.map((p) => p.name), ["domain"]);

  for (const op of ops) {
    assertEquals(
      op.pathParams.some((p) => p.name === "account"),
      false,
      `${op.operationId} kept the account parameter`,
    );
  }
});

Deno.test("groupOperations: resolves $ref parameters and request bodies", () => {
  const byId = Object.fromEntries(
    groupOperations(loadSpec(), SERVICES).flatMap((g) => g.operations)
      .map((o) => [o.operationId, o]),
  );
  // Filter and sort parameters are components.parameters refs.
  assertEquals(
    byId.listZoneRecords.queryParams.map((p) => p.name).sort(),
    ["name", "name_like", "sort", "type"],
  );
  // 25 of 29 request bodies are components.requestBodies refs.
  assertEquals(
    Object.keys(byId.createZoneRecord.requestBody!.properties!).includes(
      "content",
    ),
    true,
  );
  assertEquals(byId.deleteZoneRecord.requestBody, undefined);
});

Deno.test("groupOperations: an unclaimed operation fails generation", () => {
  assertThrows(
    () =>
      groupOperations(specOf("/stray", "/zones"), [service("z", ["/zones"])]),
    Error,
    "op0 (GET /stray) matches no service",
  );
});

Deno.test("groupOperations: an operation two services claim equally fails generation", () => {
  assertThrows(
    () =>
      groupOperations(specOf("/zones/x"), [
        service("a", ["/zones"]),
        service("b", ["/zones"]),
      ]),
    Error,
    "matches a and b",
  );
});

Deno.test("groupOperations: a --service subset still runs the claim checks", () => {
  assertThrows(
    () =>
      groupOperations(specOf("/stray", "/zones"), [service("z", ["/zones"])], {
        only: ["z"],
      }),
    Error,
    "matches no service",
  );
});

Deno.test("groupOperations: an excluded operation needs no service", () => {
  const groups = groupOperations(
    specOf("/stray", "/zones"),
    [service("z", ["/zones"])],
    { excluded: ["op0"] },
  );
  assertEquals(groups.map((g) => g.config.name), ["z"]);
});

Deno.test("groupOperations: only returns the requested services", () => {
  const groups = groupOperations(loadSpec(), SERVICES, { only: ["tlds"] });
  assertEquals(groups.map((g) => g.config.name), ["tlds"]);
});

Deno.test("findService: the longest prefix wins and matching respects segment edges", () => {
  const services = [
    service("domains", ["/{account}/domains"]),
    service("dnssec", ["/{account}/domains/{domain}/dnssec"]),
  ];
  const name = (path: string) => {
    const m = findService(path, services);
    return m.kind === "service" ? m.service.name : m.kind;
  };
  assertEquals(name("/{account}/domains/{domain}/dnssec"), "dnssec");
  assertEquals(name("/{account}/domains/{domain}"), "domains");
  assertEquals(name("/{account}/domains"), "domains");
  assertEquals(name("/{account}/domainsfoo"), "none");
});

Deno.test("findService: excludePaths removes a sub-tree from a service", () => {
  const services = [
    service("domains", ["/d"], ["/d/child"]),
    service("child", ["/d/child"]),
  ];
  const m = findService("/d/child/x", services);
  assertEquals(m.kind === "service" && m.service.name, "child");
});

Deno.test("withTemplatePlaceholders: adds undeclared placeholders as string path params", () => {
  const declared = [
    { name: "zone", in: "path", required: true },
  ] as ParameterObject[];
  const out = withTemplatePlaceholders("/z/{zone}/r/{record}", declared);
  assertEquals(out.map((p) => p.name), ["zone", "record"]);
  assertEquals(out[1].schema, { type: "string" });
  assertEquals(out[1].in, "path");
});

Deno.test("groupOperations: a non-JSON request body or a response with no data fails generation", () => {
  const spec = specOf("/a", "/b");
  const a = spec.paths["/a"].get as Record<string, unknown>;
  a.requestBody = { content: { "text/plain": { schema: { type: "string" } } } };
  assertThrows(
    () => groupOperations(spec, [service("s", ["/a", "/b"])]),
    Error,
    "op0: request body is not application/json",
  );

  const spec2 = specOf("/a");
  const a2 = spec2.paths["/a"].get as Record<string, unknown>;
  a2.responses = {
    "200": {
      content: {
        "application/json": {
          schema: { type: "object", properties: { other: { type: "string" } } },
        },
      },
    },
  };
  assertThrows(
    () => groupOperations(spec2, [service("s", ["/a"])]),
    Error,
    "no `data` property",
  );
});
