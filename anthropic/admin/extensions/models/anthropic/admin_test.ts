// Claude Enterprise Admin API Model Tests
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertExists,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { AdminClient, AdminNetworkError, model } from "./admin.ts";

// ---------------------------------------------------------------------------
// Model Export Structure Tests
// ---------------------------------------------------------------------------

Deno.test("admin model: has correct type and version format", () => {
  assertEquals(model.type, "@webframp/anthropic/admin");
  assertEquals(/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(model.version), true);
});

Deno.test("admin model: global arguments", () => {
  assertExists(model.globalArguments.shape.adminKey);
  assertExists(model.globalArguments.shape.requestsPerMinute);
  // The API's per-organization limit is the ceiling.
  assertEquals(
    model.globalArguments.safeParse({ adminKey: "k", requestsPerMinute: 101 })
      .success,
    false,
  );
});

Deno.test("admin model: has required resources and methods", () => {
  for (
    const r of [
      "members",
      "rbacRoles",
      "rbacGroups",
      "groupMemberChanges",
      "roleChanges",
    ]
  ) {
    assertExists((model.resources as Record<string, unknown>)[r], r);
  }
  for (
    const m of [
      "sync_members",
      "sync_access",
      "add_group_members",
      "set_member_roles",
    ]
  ) {
    assertExists((model.methods as Record<string, unknown>)[m], m);
  }
});

Deno.test("admin model: write methods default to dry run", () => {
  const add = model.methods.add_group_members.arguments.parse({
    groupId: "rbac_group_x",
    roles: ["user"],
  });
  assertEquals(add.dryRun, true);
  const set = model.methods.set_member_roles.arguments.parse({
    role: "managed",
    fromRoles: ["user"],
    requireGroupId: "rbac_group_x",
    expectRoleId: "rbac_role_x",
  });
  assertEquals(set.dryRun, true);
});

// ---------------------------------------------------------------------------
// Fake Admin API
// ---------------------------------------------------------------------------

type FakeUser = { id: string; email: string; name: string; role: string };
type FakeGroup = {
  id: string;
  name: string;
  source_type: string;
  role_ids: string[] | null;
  members: string[];
};

type Call = { method: string; path: string; body?: any; at: number };

type FakeState = { users: FakeUser[]; groups: FakeGroup[]; calls: Call[] };

type FakeOpts = {
  users?: FakeUser[];
  groups?: FakeGroup[];
  pageSize?: number;
  /** Return this for a role update instead of applying it. */
  failRoleUpdate?: (id: string) => Response | null;
  /** Return this for a group add instead of applying it. */
  failGroupAdd?: (id: string) => Response | null;
  /** Answer the first N requests with 429. */
  rateLimitFirst?: number;
  /** retry-after header on 429s; null omits it. Default "0". */
  retryAfter?: string | null;
  /** Throw a network error for the first N requests. */
  networkFailFirst?: number;
  /** Override a GET response body for a path. */
  listOverride?: (path: string) => unknown | undefined;
  /** Hold role updates open until the request is aborted. */
  hangRoleUpdates?: boolean;
  /** Called after each applied write. */
  afterWrite?: (s: FakeState) => void;
  /** Send a body that errors mid-read for the first N requests. */
  brokenBodyFirst?: number;
  /** Repeat every group-member row (a duplicate-row API bug). */
  duplicateGroupRows?: boolean;
};

function fakeApi(opts: FakeOpts = {}) {
  const users: FakeUser[] = structuredClone(
    opts.users ?? [
      { id: "user_owner", email: "o@x.org", name: "O", role: "primary_owner" },
      { id: "user_admin", email: "a@x.org", name: "A", role: "owner" },
      { id: "user_m1", email: "m1@x.org", name: "M1", role: "managed" },
      { id: "user_u1", email: "u1@x.org", name: "U1", role: "user" },
      { id: "user_u2", email: "u2@x.org", name: "U2", role: "user" },
      { id: "user_u3", email: "u3@x.org", name: "U3", role: "user" },
    ],
  );
  const groups: FakeGroup[] = structuredClone(
    opts.groups ?? [
      {
        id: "rbac_group_base",
        name: "Example-Base",
        source_type: "direct",
        role_ids: ["rbac_role_base"],
        members: ["user_m1", "user_u1"],
      },
      {
        id: "rbac_group_scim",
        name: "Example-Scim-Max",
        source_type: "scim",
        role_ids: ["rbac_role_max"],
        members: ["user_u2"],
      },
    ],
  );
  const roles = [
    { id: "rbac_role_base", display_name: "Example_Base" },
    { id: "rbac_role_max", display_name: "Max" },
  ];
  const calls: Call[] = [];
  const state: FakeState = { users, groups, calls };
  let rateLimited = opts.rateLimitFirst ?? 0;
  let networkFails = opts.networkFailFirst ?? 0;
  let brokenBodies = opts.brokenBodyFirst ?? 0;
  const pageSize = opts.pageSize ?? 1000;

  const cursorPage = (items: unknown[], page: string | null) => {
    const start = page ? Number(page) : 0;
    const slice = items.slice(start, start + pageSize);
    const next = start + pageSize < items.length
      ? String(start + pageSize)
      : null;
    return Response.json({
      data: slice,
      has_more: next !== null,
      next_page: next,
    });
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.body ? await req.json() : undefined;
    calls.push({ method: req.method, path, body, at: Date.now() });
    if (networkFails > 0) {
      networkFails--;
      throw new TypeError("connection reset");
    }
    if (brokenBodies > 0) {
      brokenBodies--;
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new TypeError("connection reset mid-body"));
          },
        }),
      );
    }
    if (req.headers.get("x-api-key") !== "test-key") {
      return new Response("unauthorized", { status: 401 });
    }
    if (rateLimited > 0) {
      rateLimited--;
      const headers: Record<string, string> = {};
      const ra = opts.retryAfter === undefined ? "0" : opts.retryAfter;
      if (ra !== null) headers["retry-after"] = ra;
      return new Response("slow down", { status: 429, headers });
    }
    if (req.method === "GET") {
      const o = opts.listOverride?.(path);
      if (o !== undefined) return Response.json(o);
    }

    if (req.method === "GET" && path === "/v1/organizations/users") {
      const after = url.searchParams.get("after_id");
      const start = after ? users.findIndex((u) => u.id === after) + 1 : 0;
      const slice = users.slice(start, start + pageSize);
      return Response.json({
        data: slice.map((u) => ({ type: "user", ...u, added_at: null })),
        has_more: start + pageSize < users.length,
        first_id: slice[0]?.id ?? null,
        last_id: slice[slice.length - 1]?.id ?? null,
      });
    }
    let m = path.match(/^\/v1\/organizations\/users\/([^/]+)$/);
    if (m && req.method === "POST") {
      if (opts.hangRoleUpdates) {
        await new Promise((_, reject) =>
          req.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
          )
        );
      }
      const fail = opts.failRoleUpdate?.(m[1]);
      if (fail) return fail;
      const u = users.find((x) => x.id === m![1]);
      if (!u) return new Response("not found", { status: 404 });
      u.role = body.role;
      opts.afterWrite?.(state);
      return Response.json({ type: "user", ...u });
    }
    if (req.method === "GET" && path === "/v1/organizations/rbac_roles") {
      return cursorPage(roles, url.searchParams.get("page"));
    }
    if (req.method === "GET" && path === "/v1/organizations/rbac_groups") {
      return cursorPage(
        groups.map(({ members: _m, ...g }) => ({ type: "rbac_group", ...g })),
        url.searchParams.get("page"),
      );
    }
    m = path.match(/^\/v1\/organizations\/rbac_groups\/([^/]+)$/);
    if (m && req.method === "GET") {
      const g = groups.find((x) => x.id === m![1]);
      if (!g) return new Response("not found", { status: 404 });
      const { members: _m, ...rest } = g;
      return Response.json({ type: "rbac_group", ...rest });
    }
    m = path.match(/^\/v1\/organizations\/rbac_groups\/([^/]+)\/members$/);
    if (m) {
      const g = groups.find((x) => x.id === m![1]);
      if (!g) return new Response("not found", { status: 404 });
      if (req.method === "GET") {
        const rows = g.members.map((id) => ({
          type: "rbac_group_member",
          rbac_group_id: g.id,
          user_id: id,
          email: users.find((u) => u.id === id)?.email ?? "",
        }));
        return cursorPage(
          opts.duplicateGroupRows ? [...rows, ...rows] : rows,
          url.searchParams.get("page"),
        );
      }
      if (req.method === "POST") {
        const fail = opts.failGroupAdd?.(body.user_id);
        if (fail) return fail;
        if (g.source_type === "scim") {
          return new Response("scim group", { status: 400 });
        }
        if (g.members.includes(body.user_id)) {
          return new Response("user is already a member of this group", {
            status: 400,
          });
        }
        g.members.push(body.user_id);
        opts.afterWrite?.(state);
        return Response.json({
          type: "rbac_group_member",
          user_id: body.user_id,
        });
      }
    }
    return new Response("no route", { status: 404 });
  };

  return { ...state, handler };
}

async function withFakeApi<T>(
  api: ReturnType<typeof fakeApi>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) =>
    api.handler(new Request(input as string, init));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// Above the schema's 100/min cap on purpose: unit tests bypass schema
// validation so they don't sleep between requests. Pacing has its own test.
const GLOBAL_ARGS = { adminKey: "test-key", requestsPerMinute: 600_000 };

function ctx(signal?: AbortSignal) {
  return createModelTestContext({ globalArgs: GLOBAL_ARGS, signal });
}

const writes = (api: ReturnType<typeof fakeApi>) =>
  api.calls.filter((c) => c.method !== "GET");

const fastClient = (key = "test-key") =>
  new AdminClient(key, 600_000, undefined, 30_000, 1);

const users = (n: number, role = "user") =>
  Array.from({ length: n }, (_, i) => ({
    id: `user_${i}`,
    email: `${i}@x.org`,
    name: `${i}`,
    role,
  }));

const baseGroup = (members: string[]): FakeGroup => ({
  id: "rbac_group_base",
  name: "Base",
  source_type: "direct",
  role_ids: ["rbac_role_base"],
  members,
});

const MANAGED = {
  role: "managed" as const,
  fromRoles: ["user"],
  requireGroupId: "rbac_group_base",
  expectRoleId: "rbac_role_base",
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

Deno.test("client: follows member pagination by last_id", async () => {
  const api = fakeApi({ pageSize: 2 });
  const members = await withFakeApi(api, () => fastClient().listMembers());
  assertEquals(members.length, 6);
  assertEquals(
    api.calls.filter((c) => c.path === "/v1/organizations/users").length,
    3,
  );
});

Deno.test("client: follows group cursor pagination", async () => {
  const api = fakeApi({ pageSize: 1 });
  const groups = await withFakeApi(
    api,
    () => fastClient().listCursor("/v1/organizations/rbac_groups"),
  );
  assertEquals(groups.length, 2);
});

Deno.test("client: refuses a member page without has_more", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/users"
        ? { data: [{ id: "user_1", role: "user" }] }
        : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listMembers(),
      Error,
      "unexpected page shape",
    );
  });
});

Deno.test("client: refuses a member page without a data array", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/users" ? { has_more: false } : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listMembers(),
      Error,
      "unexpected page shape",
    );
  });
});

Deno.test("client: refuses has_more without last_id", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/users"
        ? { data: [{ id: "user_1", role: "user" }], has_more: true }
        : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listMembers(),
      Error,
      "advancing last_id",
    );
  });
});

Deno.test("client: refuses cursor has_more without next_page", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/rbac_groups"
        ? { data: [], has_more: true, next_page: null }
        : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listCursor("/v1/organizations/rbac_groups"),
      Error,
      "without a next_page",
    );
  });
});

Deno.test("client: refuses a cursor page without a data array", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/rbac_groups" ? { next_page: null } : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listCursor("/v1/organizations/rbac_groups"),
      Error,
      "no data array",
    );
  });
});

Deno.test("client: refuses a repeating cursor", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/rbac_groups"
        ? { data: [], has_more: true, next_page: "same" }
        : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listCursor("/v1/organizations/rbac_groups"),
      Error,
      "repeating",
    );
  });
});

Deno.test("client: honors retry-after 0 without backing off", async () => {
  const api = fakeApi({ rateLimitFirst: 2, retryAfter: "0" });
  const client = new AdminClient("test-key", 600_000); // default 1s backoff
  const start = Date.now();
  const members = await withFakeApi(api, () => client.listMembers());
  assertEquals(members.length, 6);
  assertEquals(api.calls.length, 3);
  assertEquals(Date.now() - start < 900, true);
});

Deno.test("client: backs off exponentially without retry-after", async () => {
  const api = fakeApi({ rateLimitFirst: 2, retryAfter: null });
  const client = new AdminClient("test-key", 600_000, undefined, 30_000, 50);
  const start = Date.now();
  await withFakeApi(api, () => client.listMembers());
  // 50ms + 100ms
  assertEquals(Date.now() - start >= 140, true);
});

Deno.test("client: fails at once on a retry-after beyond the cap", async () => {
  const api = fakeApi({ rateLimitFirst: 1, retryAfter: "3600" });
  await withFakeApi(api, async () => {
    await assertRejects(() => fastClient().listMembers(), Error, "429");
  });
  assertEquals(api.calls.length, 1);
});

Deno.test("client: gives up after repeated 429s", async () => {
  const api = fakeApi({ rateLimitFirst: 100 });
  await withFakeApi(api, async () => {
    await assertRejects(() => fastClient().listMembers(), Error, "429");
  });
  assertEquals(api.calls.length, 6);
});

Deno.test("client: retries network errors then succeeds", async () => {
  const api = fakeApi({ networkFailFirst: 2 });
  const members = await withFakeApi(api, () => fastClient().listMembers());
  assertEquals(members.length, 6);
  assertEquals(api.calls.length, 3);
});

Deno.test("client: network errors exhaust into AdminNetworkError", async () => {
  const api = fakeApi({ networkFailFirst: 100 });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listMembers(),
      AdminNetworkError,
      "no response",
    );
  });
  assertEquals(api.calls.length, 6);
});

Deno.test("client: does not retry permanent errors", async () => {
  const api = fakeApi();
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient("wrong-key").listMembers(),
      Error,
      "401",
    );
  });
  assertEquals(api.calls.length, 1);
});

Deno.test("client: paces requests to requestsPerMinute", async () => {
  const api = fakeApi({ pageSize: 2 }); // 3 member pages
  const client = new AdminClient("test-key", 600); // 100ms apart
  await withFakeApi(api, () => client.listMembers());
  const gaps = api.calls.slice(1).map((c, i) => c.at - api.calls[i].at);
  assertEquals(gaps.length, 2);
  for (const g of gaps) assertEquals(g >= 95, true, `gap ${g}ms`);
});

// ---------------------------------------------------------------------------
// sync_members / sync_access
// ---------------------------------------------------------------------------

Deno.test("sync_members: writes roster with role counts", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(
    api,
    () => model.methods.sync_members.execute({}, context as any),
  );
  const [w] = getWrittenResources();
  assertEquals(w.specName, "members");
  assertEquals((w.data as any).count, 6);
  assertEquals((w.data as any).roleCounts, {
    primary_owner: 1,
    owner: 1,
    managed: 1,
    user: 3,
  });
});

Deno.test("sync_access: groups carry role names, members and role counts", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(
    api,
    () => model.methods.sync_access.execute({}, context as any),
  );
  const byName = Object.fromEntries(
    getWrittenResources().map((w) => [w.name, w.data as any]),
  );
  assertEquals(byName.rbacRoles.count, 2);
  const base = byName.rbacGroups.groups.find((g: any) =>
    g.id === "rbac_group_base"
  );
  assertEquals(base.role_names, ["Example_Base"]);
  assertEquals(base.member_count, 2);
  assertEquals(base.member_role_counts, { managed: 1, user: 1 });
  assertEquals(base.source_type, "direct");
  assertEquals(writes(api).length, 0);
});

// ---------------------------------------------------------------------------
// add_group_members
// ---------------------------------------------------------------------------

Deno.test("add_group_members: dry run reports and sends no writes", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      { groupId: "rbac_group_base", roles: ["user", "managed"] },
      context as any,
    ));
  const w = getWrittenResources()[0];
  const data = w.data as any;
  assertEquals(w.name === "add:rbac_group_base:dryrun", true);
  assertEquals(data.dryRun, true);
  assertEquals(data.targeted, 4);
  assertEquals(data.alreadyMember, 2);
  assertEquals(data.added.map((m: any) => m.user_id), ["user_u2", "user_u3"]);
  assertEquals(writes(api).length, 0);
});

Deno.test("add_group_members: applies, skipping existing members and privileged roles", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      {
        groupId: "rbac_group_base",
        expectRoleId: "rbac_role_base",
        roles: ["user", "managed"],
        dryRun: false,
      },
      context as any,
    ));
  const w = getWrittenResources()[0];
  assertEquals(w.name === "add:rbac_group_base:apply", true);
  assertEquals((w.data as any).added.length, 2);
  assertEquals((w.data as any).failed, []);
  assertEquals(
    api.groups[0].members.sort(),
    ["user_m1", "user_u1", "user_u2", "user_u3"],
  );
  assertEquals(writes(api).length, 2);
});

Deno.test("add_group_members: explicit ineligible userIds are skipped", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      {
        groupId: "rbac_group_base",
        userIds: ["user_owner", "user_u3", "user_gone"],
        dryRun: false,
      },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.skippedIneligible.map((m: any) => m.user_id), [
    "user_owner",
  ]);
  assertEquals(data.notFound, ["user_gone"]);
  assertEquals(data.added.map((m: any) => m.user_id), ["user_u3"]);
  assertEquals(data.selection, {
    userIds: ["user_owner", "user_u3", "user_gone"],
  });
});

Deno.test("add_group_members: only user and managed roles can be selected", async () => {
  const api = fakeApi();
  for (
    const roles of [["user", "owner"], ["user", "membership_admin"], ["admin"]]
  ) {
    const { context } = ctx();
    await withFakeApi(api, async () => {
      await assertRejects(
        () =>
          model.methods.add_group_members.execute(
            { groupId: "rbac_group_base", roles },
            context as any,
          ),
        Error,
        "Refusing to target roles",
      );
    });
  }
  assertEquals(writes(api).length, 0);
});

Deno.test("add_group_members: refuses scim groups", async () => {
  const api = fakeApi();
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.add_group_members.execute(
          { groupId: "rbac_group_scim", roles: ["user"] },
          context as any,
        ),
      Error,
      "scim",
    );
  });
  assertEquals(writes(api).length, 0);
});

Deno.test("add_group_members: refuses a group without the expected role", async () => {
  const api = fakeApi();
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.add_group_members.execute(
          {
            groupId: "rbac_group_base",
            expectRoleId: "rbac_role_other",
            roles: ["user"],
          },
          context as any,
        ),
      Error,
      "does not carry role",
    );
  });
});

Deno.test("add_group_members: unavailable role data is a retryable error", async () => {
  const api = fakeApi({
    users: users(2),
    groups: [{ ...baseGroup([]), role_ids: null }],
  });
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.add_group_members.execute(
          { groupId: "rbac_group_base", roles: ["user"] },
          context as any,
        ),
      Error,
      "unavailable",
    );
  });
});

Deno.test("add_group_members: requires exactly one selector", async () => {
  const api = fakeApi();
  const selections = [
    {},
    { roles: ["user"], userIds: ["user_u1"] },
    { roles: [], userIds: [] },
  ];
  for (const sel of selections) {
    const { context } = ctx();
    await withFakeApi(api, async () => {
      await assertRejects(
        () =>
          model.methods.add_group_members.execute(
            { groupId: "rbac_group_base", ...sel },
            context as any,
          ),
        Error,
        "exactly one",
      );
    });
  }
});

Deno.test("add_group_members: an empty roles list does not mask userIds", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      { groupId: "rbac_group_base", roles: [], userIds: ["user_u3"] },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.added.map((m: any) => m.user_id), ["user_u3"]);
});

Deno.test("add_group_members: treats a racing 'already a member' 400 as done", async () => {
  const api = fakeApi({
    failGroupAdd: (id) =>
      id === "user_u2"
        ? new Response("user is already a member", { status: 400 })
        : null,
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      { groupId: "rbac_group_base", roles: ["user"], dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.alreadyMember, 2);
  assertEquals(data.added.map((m: any) => m.user_id), ["user_u3"]);
});

Deno.test("add_group_members: stops on 403 even after successes, and records it", async () => {
  let n = 0;
  const api = fakeApi({
    users: users(10),
    groups: [baseGroup([])],
    failGroupAdd: () =>
      ++n > 2 ? new Response("missing scope", { status: 403 }) : null,
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.add_group_members.execute(
          { groupId: "rbac_group_base", roles: ["user"], dryRun: false },
          context as any,
        ),
      Error,
      "Authorization failed",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.added.length, 2);
  assertEquals(data.failed.length, 1);
  assertEquals(data.failed[0].previousRole, "user");
  assertEquals(writes(api).length, 3);
});

Deno.test("add_group_members: stops after repeated identical failures after successes", async () => {
  let n = 0;
  const api = fakeApi({
    users: users(10),
    groups: [baseGroup([])],
    failGroupAdd: () =>
      ++n > 2 ? new Response("bad request", { status: 422 }) : null,
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.add_group_members.execute(
          { groupId: "rbac_group_base", roles: ["user"], dryRun: false },
          context as any,
        ),
      Error,
      "3 consecutive",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.added.length, 2);
  assertEquals(data.failed.length, 3);
  assertEquals(writes(api).length, 5);
});

// ---------------------------------------------------------------------------
// set_member_roles
// ---------------------------------------------------------------------------

Deno.test("set_member_roles: managed requires coverage arguments", async () => {
  const api = fakeApi();
  const cases: [Record<string, string>, string][] = [
    [{}, "requires requireRoleId, or requireGroupId and expectRoleId"],
    [
      { requireGroupId: "rbac_group_base" },
      "requires requireRoleId, or requireGroupId and expectRoleId",
    ],
    [{ expectRoleId: "rbac_role_base" }, "expectRoleId needs requireGroupId"],
    [
      { requireRoleId: "rbac_role_base", requireGroupId: "rbac_group_base" },
      "not both",
    ],
  ];
  for (const [extra, msg] of cases) {
    const { context } = ctx();
    await withFakeApi(api, async () => {
      await assertRejects(
        () =>
          model.methods.set_member_roles.execute(
            { role: "managed", fromRoles: ["user"], ...extra },
            context as any,
          ),
        Error,
        msg,
      );
    });
  }
  assertEquals(api.calls.length, 0);
});

Deno.test("set_member_roles: refuses a required group without the role", async () => {
  // A SCIM group with no roles: switching its members would leave them
  // Custom with no permissions.
  const api = fakeApi({
    groups: [{
      id: "rbac_group_empty",
      name: "Empty",
      source_type: "scim",
      role_ids: [],
      members: ["user_u1", "user_u2"],
    }],
  });
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, requireGroupId: "rbac_group_empty", dryRun: false },
          context as any,
        ),
      Error,
      "does not carry role",
    );
  });
  assertEquals(writes(api).length, 0);
});

Deno.test("set_member_roles: only switches members already in the group", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { ...MANAGED, dryRun: false },
      context as any,
    ));
  const w = getWrittenResources()[0];
  const data = w.data as any;
  assertEquals(w.name === "roles:managed:apply", true);
  assertEquals(data.changed, [{
    userId: "user_u1",
    email: "u1@x.org",
    previousRole: "user",
    newRole: "managed",
  }]);
  assertEquals(
    data.skippedNotInGroup.map((m: any) => m.user_id),
    ["user_u2", "user_u3"],
  );
  assertEquals(api.users.find((u) => u.id === "user_u2")!.role, "user");
  assertEquals(writes(api).length, 1);
});

Deno.test("set_member_roles: add-then-switch converts every non-privileged user", async () => {
  const api = fakeApi();
  await withFakeApi(api, async () => {
    await model.methods.add_group_members.execute(
      { groupId: "rbac_group_base", roles: ["user", "managed"], dryRun: false },
      ctx().context as any,
    );
    await model.methods.set_member_roles.execute(
      { ...MANAGED, dryRun: false },
      ctx().context as any,
    );
  });
  const roles = Object.fromEntries(api.users.map((u) => [u.id, u.role]));
  assertEquals(roles, {
    user_owner: "primary_owner",
    user_admin: "owner",
    user_m1: "managed",
    user_u1: "managed",
    user_u2: "managed",
    user_u3: "managed",
  });
  // Group memberships outside the base group are untouched.
  assertEquals(api.groups[1].members, ["user_u2"]);
});

Deno.test("set_member_roles: dry run sends no writes and records separately from apply", async () => {
  const api = fakeApi();
  const dry = ctx();
  const apply = ctx();
  await withFakeApi(api, async () => {
    await model.methods.set_member_roles.execute(MANAGED, dry.context as any);
    assertEquals(writes(api).length, 0);
    await model.methods.set_member_roles.execute(
      { ...MANAGED, dryRun: false },
      apply.context as any,
    );
  });
  const dryName = dry.getWrittenResources()[0].name;
  const applyName = apply.getWrittenResources()[0].name;
  assertEquals(dryName === "roles:managed:dryrun", true);
  assertNotEquals(dryName, applyName);
});

Deno.test("set_member_roles: rollback by userIds restores user role", async () => {
  const api = fakeApi();
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { role: "user", userIds: ["user_m1", "user_admin"], dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.map((c: any) => c.userId), ["user_m1"]);
  assertEquals(data.skippedIneligible.map((m: any) => m.user_id), [
    "user_admin",
  ]);
  assertEquals(api.users.find((u) => u.id === "user_admin")!.role, "owner");
});

Deno.test("set_member_roles: IdP-managed roles stop the run early", async () => {
  const api = fakeApi({
    users: users(10),
    groups: [baseGroup(users(10).map((u) => u.id))],
    failRoleUpdate: () =>
      new Response("roles are managed by your identity provider", {
        status: 400,
      }),
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "stopped",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.failed.length, 3);
  assertEquals(data.failed[0].outcome, "failed");
  assertEquals(data.changed.length, 0);
});

Deno.test("set_member_roles: isolated failures are recorded, the run continues", async () => {
  const api = fakeApi({
    failRoleUpdate: (id) =>
      id === "user_u2" ? new Response("boom", { status: 404 }) : null,
  });
  api.groups[0].members.push("user_u2", "user_u3");
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "2 changed, 1 failed",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.map((c: any) => c.userId), ["user_u1", "user_u3"]);
  assertEquals(
    data.failed.map((f: any) => [f.userId, f.status, f.previousRole]),
    [["user_u2", 404, "user"]],
  );
  assertEquals(data.aborted, null);
});

Deno.test("set_member_roles: a response with the wrong role is an unknown outcome", async () => {
  const api = fakeApi({
    failRoleUpdate: () => Response.json({ type: "user", role: "user" }),
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "1 failed",
    );
  });
  const f = (getWrittenResources()[0].data as any).failed[0];
  assertEquals([f.userId, f.outcome], ["user_u1", "unknown"]);
});

Deno.test("set_member_roles: cancel mid-request records the member as unknown", async () => {
  const api = fakeApi({ hangRoleUpdates: true });
  const controller = new AbortController();
  const { context, getWrittenResources } = ctx(controller.signal);
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 50);
  try {
    await withFakeApi(api, async () => {
      await assertRejects(
        () =>
          model.methods.set_member_roles.execute(
            { ...MANAGED, dryRun: false },
            context as any,
          ),
        Error,
        "Cancelled",
      );
    });
  } finally {
    clearTimeout(timer);
  }
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.aborted, "Cancelled");
  assertEquals(
    data.failed.map((f: any) => [f.userId, f.outcome, f.previousRole]),
    [["user_u1", "unknown", "user"]],
  );
});

Deno.test("set_member_roles: re-reads the group and skips members removed mid-run", async () => {
  const all = users(150);
  const api = fakeApi({
    users: all,
    groups: [baseGroup(all.map((u) => u.id))],
    // After the first write, someone removes user_120 from the group.
    afterWrite: (s) => {
      s.groups[0].members = s.groups[0].members.filter((id) =>
        id !== "user_120"
      );
    },
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { ...MANAGED, dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.length, 149);
  assertEquals(data.skippedNotInGroup.map((m: any) => m.user_id), [
    "user_120",
  ]);
  assertEquals(api.users.find((u) => u.id === "user_120")!.role, "user");
});

Deno.test("client: a body that fails mid-read is retried", async () => {
  const api = fakeApi({ brokenBodyFirst: 2 });
  const members = await withFakeApi(api, () => fastClient().listMembers());
  assertEquals(members.length, 6);
  assertEquals(api.calls.length, 3);
});

Deno.test("client: duplicate group-member rows are collapsed", async () => {
  const api = fakeApi({ duplicateGroupRows: true });
  const rows = await withFakeApi(
    api,
    () => fastClient().listGroupMembers("rbac_group_base"),
  );
  assertEquals(rows.map((r) => r.user_id), ["user_m1", "user_u1"]);
});

Deno.test("set_member_roles: a 5xx after retries is an unknown outcome", async () => {
  const api = fakeApi({
    failRoleUpdate: () =>
      new Response("bad gateway", {
        status: 502,
        headers: { "retry-after": "0" },
      }),
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    api.groups[0].members = ["user_u1"];
    const client = model.methods.set_member_roles;
    await assertRejects(
      () =>
        client.execute(
          {
            ...MANAGED,
            userIds: ["user_u1"],
            fromRoles: undefined,
            dryRun: false,
          } as any,
          context as any,
        ),
      Error,
      "1 failed",
    );
  });
  const f = (getWrittenResources()[0].data as any).failed[0];
  assertEquals([f.userId, f.status, f.outcome], ["user_u1", 502, "unknown"]);
});

Deno.test("set_member_roles: cancel before any request is sent records no failure", async () => {
  const api = fakeApi();
  const controller = new AbortController();
  // 1 request/s: reads go out at 0s, 1s and 2s; the first role write waits
  // for its 3s slot, and the cancel lands at 2.5s, before it is sent.
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { adminKey: "test-key", requestsPerMinute: 60 },
    signal: controller.signal,
  });
  const timer = setTimeout(
    () => controller.abort(new Error("cancelled")),
    2500,
  );
  try {
    await withFakeApi(api, async () => {
      await assertRejects(
        () =>
          model.methods.set_member_roles.execute(
            { ...MANAGED, dryRun: false },
            context as any,
          ),
        Error,
        "Cancelled",
      );
    });
  } finally {
    clearTimeout(timer);
  }
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.aborted, "Cancelled");
  assertEquals(data.failed, []);
  assertEquals(writes(api).length, 0);
});

Deno.test("set_member_roles: removals after a re-read do not trigger extra re-reads", async () => {
  const all = users(110);
  let n = 0;
  const api = fakeApi({
    users: all,
    groups: [baseGroup(all.map((u) => u.id))],
    // Right after the 100th write, five not-yet-switched members leave.
    afterWrite: (s) => {
      if (++n === 100) {
        const gone = new Set([
          "user_100",
          "user_101",
          "user_102",
          "user_103",
          "user_104",
        ]);
        s.groups[0].members = s.groups[0].members.filter((id) => !gone.has(id));
      }
    },
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { ...MANAGED, dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.length, 105);
  assertEquals(data.skippedNotInGroup.length, 5);
  const groupReads =
    api.calls.filter((c) => c.method === "GET" && c.path.endsWith("/members"))
      .length;
  assertEquals(groupReads, 2);
});

Deno.test("set_member_roles: a final 4xx after a timed-out attempt stays unknown", async () => {
  let n = 0;
  const api = fakeApi({
    networkFailFirst: 0,
    failRoleUpdate: () =>
      ++n === 1
        ? new Response("bad gateway", {
          status: 504,
          headers: { "retry-after": "0" },
        })
        : new Response("not found", { status: 404 }),
  });
  api.groups[0].members = ["user_u1"];
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "1 failed",
    );
  });
  const f = (getWrittenResources()[0].data as any).failed[0];
  assertEquals([f.status, f.outcome], [404, "unknown"]);
});

Deno.test("set_member_roles: a clean 4xx is a definite failure", async () => {
  const api = fakeApi({
    failRoleUpdate: () => new Response("not found", { status: 404 }),
  });
  api.groups[0].members = ["user_u1"];
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "1 failed",
    );
  });
  const f = (getWrittenResources()[0].data as any).failed[0];
  assertEquals([f.status, f.outcome], [404, "failed"]);
});

// ---------------------------------------------------------------------------
// requireRoleId coverage mode
// ---------------------------------------------------------------------------

const BY_ROLE = {
  role: "managed" as const,
  fromRoles: ["user"],
  requireRoleId: "rbac_role_base",
};

/** Two groups carry the base role (one SCIM), one does not; u3 is ungrouped. */
const coverageGroups = (): FakeGroup[] => [
  {
    id: "rbac_group_a",
    name: "A",
    source_type: "scim",
    role_ids: ["rbac_role_max", "rbac_role_base"],
    members: ["user_u1", "user_m1"],
  },
  {
    id: "rbac_group_b",
    name: "B",
    source_type: "direct",
    role_ids: ["rbac_role_base"],
    members: ["user_u1", "user_owner"],
  },
  {
    id: "rbac_group_c",
    name: "C",
    source_type: "scim",
    role_ids: ["rbac_role_max"],
    members: ["user_u2"],
  },
];

Deno.test("sync_access: role_coverage counts distinct members per role", async () => {
  const api = fakeApi({ groups: coverageGroups() });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(
    api,
    () => model.methods.sync_access.execute({}, context as any),
  );
  const g = getWrittenResources().find((w) => w.name === "rbacGroups")!
    .data as any;
  assertEquals(g.role_data_complete, true);
  assertEquals(g.role_coverage.rbac_role_base, {
    user: 1,
    managed: 1,
    primary_owner: 1,
  });
  assertEquals(g.role_coverage.rbac_role_max, { user: 2, managed: 1 });
});

Deno.test("set_member_roles requireRoleId: switches members of any carrying group only", async () => {
  const api = fakeApi({ groups: coverageGroups() });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { ...BY_ROLE, dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.requireRoleId, "rbac_role_base");
  assertEquals(data.coveringGroupIds, ["rbac_group_a", "rbac_group_b"]);
  assertEquals(data.changed.map((c: any) => c.userId), ["user_u1"]);
  // u2 is only in a group without the role; u3 is in no group.
  assertEquals(
    data.skippedNotInGroup.map((m: any) => m.user_id),
    ["user_u2", "user_u3"],
  );
  assertEquals(writes(api).length, 1);
  // No group membership changed.
  assertEquals(
    api.groups.map((g) => g.members),
    coverageGroups().map((g) => g.members),
  );
});

Deno.test("set_member_roles requireRoleId: refuses when any group's role data is unavailable", async () => {
  const groups = coverageGroups();
  groups[2].role_ids = null;
  const api = fakeApi({ groups });
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...BY_ROLE, dryRun: false },
          context as any,
        ),
      Error,
      "Role data unavailable",
    );
  });
  assertEquals(writes(api).length, 0);
});

Deno.test("set_member_roles requireRoleId: refuses a role no group carries", async () => {
  const api = fakeApi({ groups: coverageGroups() });
  const { context } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...BY_ROLE, requireRoleId: "rbac_role_none", dryRun: false },
          context as any,
        ),
      Error,
      "No group carries",
    );
  });
  assertEquals(writes(api).length, 0);
});

Deno.test("set_member_roles requireRoleId: a group losing the role mid-run stops covering", async () => {
  const all = users(150);
  const api = fakeApi({
    users: all,
    groups: [
      {
        id: "rbac_group_a",
        name: "A",
        source_type: "scim",
        role_ids: ["rbac_role_base"],
        members: all.slice(0, 100).map((u) => u.id),
      },
      {
        id: "rbac_group_b",
        name: "B",
        source_type: "scim",
        role_ids: ["rbac_role_base"],
        members: all.slice(100).map((u) => u.id),
      },
    ],
    // After the first write, the base role is detached from group B.
    afterWrite: (s) => {
      s.groups[1].role_ids = [];
    },
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.set_member_roles.execute(
      { ...BY_ROLE, dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.length, 100);
  assertEquals(data.skippedNotInGroup.length, 50);
  assertEquals(data.coveringGroupIds, ["rbac_group_a"]);
  assertEquals(api.users.filter((u) => u.role === "managed").length, 100);
});

Deno.test("client: list pagination is bounded", async () => {
  let n = 0;
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/rbac_groups"
        ? { data: [], has_more: true, next_page: `p${n++}` }
        : undefined,
  });
  await withFakeApi(api, async () => {
    await assertRejects(
      () => fastClient().listCursor("/v1/organizations/rbac_groups"),
      Error,
      "more than 50 pages",
    );
  });
  assertEquals(api.calls.length, 50);
});

// ---------------------------------------------------------------------------
// Pre-push review regressions
// ---------------------------------------------------------------------------

Deno.test("set_member_roles requireGroupId: a group losing the role mid-run stops the run", async () => {
  const all = users(150);
  const api = fakeApi({
    users: all,
    groups: [baseGroup(all.map((u) => u.id))],
    // After the first write, the role is detached from the group.
    afterWrite: (s) => {
      s.groups[0].role_ids = [];
    },
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "does not carry role",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.changed.length, 100);
  assertEquals(api.users.filter((u) => u.role === "managed").length, 100);
});

Deno.test("add_group_members: an add applied before a 5xx is recorded as added", async () => {
  let first = true;
  const api = fakeApi({
    failGroupAdd: (id) => {
      if (id === "user_u2" && first) {
        first = false;
        // The server applies the add, but the response is lost as a 502.
        api.groups[0].members.push(id);
        return new Response("bad gateway", {
          status: 502,
          headers: { "retry-after": "0" },
        });
      }
      return null;
    },
  });
  const { context, getWrittenResources } = ctx();
  await withFakeApi(api, () =>
    model.methods.add_group_members.execute(
      { groupId: "rbac_group_base", userIds: ["user_u2"], dryRun: false },
      context as any,
    ));
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.added.map((m: any) => m.user_id), ["user_u2"]);
  assertEquals(data.alreadyMember, 0);
  assertEquals(data.failed, []);
});

Deno.test("client: has_more false ends a cursor list even with a next_page", async () => {
  const api = fakeApi({
    listOverride: (p) =>
      p === "/v1/organizations/rbac_groups"
        ? {
          data: [{ id: "g1" }],
          has_more: false,
          next_page: "eyJjdXJzb3IiOjF9",
        }
        : undefined,
  });
  const groups = await withFakeApi(
    api,
    () => fastClient().listCursor("/v1/organizations/rbac_groups"),
  );
  assertEquals(groups.length, 1);
  assertEquals(api.calls.length, 1);
});

Deno.test("set_member_roles requireRoleId: lists groups once before the first write", async () => {
  const api = fakeApi({ groups: coverageGroups() });
  const { context } = ctx();
  await withFakeApi(
    api,
    () => model.methods.set_member_roles.execute(BY_ROLE, context as any),
  );
  assertEquals(
    api.calls.filter((c) => c.path === "/v1/organizations/rbac_groups").length,
    1,
  );
});

Deno.test("set_member_roles: cancel during a group re-read reports Cancelled", async () => {
  const all = users(150);
  const controller = new AbortController();
  let groupReads = 0;
  const api = fakeApi({
    users: all,
    groups: [baseGroup(all.map((u) => u.id))],
    listOverride: (p) => {
      // The second group read is the re-read at write 100: cancel there.
      if (
        p === "/v1/organizations/rbac_groups/rbac_group_base" &&
        ++groupReads === 2
      ) {
        controller.abort(new Error("cancelled"));
      }
      return undefined;
    },
  });
  const { context, getWrittenResources } = ctx(controller.signal);
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "Cancelled",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.aborted, "Cancelled");
  assertEquals(data.changed.length, 100);
});

Deno.test("set_member_roles: cancel on a re-read's last request stops before the next write", async () => {
  // Cancelling on the member-list read leaves no request for the re-read to
  // fail on, so the re-read always completes and the loop must notice.
  const all = users(150);
  const controller = new AbortController();
  let memberReads = 0;
  const api = fakeApi({
    users: all,
    groups: [baseGroup(all.map((u) => u.id))],
    listOverride: (p) => {
      if (
        p === "/v1/organizations/rbac_groups/rbac_group_base/members" &&
        ++memberReads === 2
      ) {
        controller.abort(new Error("cancelled"));
      }
      return undefined;
    },
  });
  const { context, getWrittenResources } = ctx(controller.signal);
  await withFakeApi(api, async () => {
    await assertRejects(
      () =>
        model.methods.set_member_roles.execute(
          { ...MANAGED, dryRun: false },
          context as any,
        ),
      Error,
      "Cancelled",
    );
  });
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.aborted, "Cancelled");
  assertEquals(data.changed.length, 100);
  assertEquals(writes(api).length, 100);
});
