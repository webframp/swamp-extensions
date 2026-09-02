// Crew Reference model tests.
// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import {
  assertKnownCrews,
  assertUniqueMappings,
  deriveReference,
  model,
} from "./crew_reference.ts";

const CREWS = [
  { id: "crew-alpha", name: "Crew Alpha" },
  { id: "crew-beta", name: "Crew Beta" },
];

function ctx() {
  return createModelTestContext({ globalArgs: { organization: "test-org" } });
}

Deno.test("assertUniqueMappings passes for distinct (type,value) pairs", () => {
  assertUniqueMappings([
    { crewId: "a", mappingType: "project", value: "1" },
    { crewId: "b", mappingType: "project", value: "2" },
    { crewId: "a", mappingType: "channel", value: "1" }, // same value, diff type — ok
  ]);
});

Deno.test("assertUniqueMappings is idempotent for the same crew claiming a resource twice", () => {
  // Same (type,value) mapped to the SAME crew is not a conflict.
  assertUniqueMappings([
    { crewId: "a", mappingType: "project", value: "1" },
    { crewId: "a", mappingType: "project", value: "1" },
  ]);
});

Deno.test("assertUniqueMappings throws when two crews claim one resource", () => {
  assertThrows(
    () =>
      assertUniqueMappings([
        { crewId: "a", mappingType: "project", value: "1" },
        { crewId: "b", mappingType: "project", value: "1" },
      ]),
    Error,
    "claimed by both",
  );
});

Deno.test("assertKnownCrews throws on a member referencing an unknown crew", () => {
  assertThrows(
    () =>
      assertKnownCrews(
        CREWS,
        [{
          id: "m1",
          username: "alice",
          email: "",
          crewId: "ghost/crew",
          aliases: [],
        }],
        [],
      ),
    Error,
    "unknown crew",
  );
});

Deno.test("assertKnownCrews throws on a mapping referencing an unknown crew", () => {
  assertThrows(
    () =>
      assertKnownCrews(
        CREWS,
        [],
        [{ crewId: "ghost/crew", mappingType: "project", value: "9" }],
      ),
    Error,
    "unknown crew",
  );
});

Deno.test("load writes the reference snapshot resource", async () => {
  const { context, getWrittenResources } = ctx();
  await model.methods.load.execute(
    {
      crews: CREWS,
      members: [
        {
          id: "m1",
          username: "alice",
          email: "",
          crewId: "crew-alpha",
          aliases: [],
        },
        {
          id: "m2",
          username: "bob",
          email: "",
          crewId: "crew-beta",
          aliases: [],
        },
      ],
      mappings: [
        { crewId: "crew-beta", mappingType: "project", value: "100" },
      ],
    },
    context as unknown as Parameters<typeof model.methods.load.execute>[1],
  );

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "reference");
  assertEquals(resources[0].name, "reference-current");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals((data.crews as unknown[]).length, 2);
  assertEquals((data.members as unknown[]).length, 2);
  assertEquals((data.mappings as unknown[]).length, 1);
});

Deno.test("load rejects a reference set with a mapping conflict", async () => {
  const { context } = ctx();
  await assertRejects(
    () =>
      model.methods.load.execute(
        {
          crews: CREWS,
          members: [],
          mappings: [
            {
              crewId: "crew-alpha",
              mappingType: "project",
              value: "1",
            },
            { crewId: "crew-beta", mappingType: "project", value: "1" },
          ],
        },
        context as unknown as Parameters<typeof model.methods.load.execute>[1],
      ),
    Error,
    "claimed by both",
  );
});

Deno.test("deriveReference: builds crews, members (with name alias), mappings", () => {
  const r = deriveReference(
    [
      {
        project: "team-a/repo",
        members: [
          { username: "alice", name: "Alice Smith" },
          { username: "bob", name: "Bob Jones" },
        ],
      },
      {
        project: "team-b/repo",
        members: [{ username: "carol", name: "Carol" }],
      },
    ],
    [
      { project: "team-a/repo", crewId: "crew-alpha" },
      { project: "team-b/repo", crewId: "crew-beta" },
    ],
    [{ id: "crew-alpha", name: "Crew Alpha" }],
  );
  assertEquals(r.crews.length, 2);
  assertEquals(
    r.crews.find((c) => c.id === "crew-alpha")!.name,
    "Crew Alpha",
  );
  assertEquals(
    r.crews.find((c) => c.id === "crew-beta")!.name,
    "crew-beta",
  ); // default to id
  assertEquals(r.members.length, 3);
  const alice = r.members.find((m) => m.username === "alice")!;
  assertEquals(alice.crewId, "crew-alpha");
  assertEquals(alice.aliases, ["Alice Smith"]); // display name auto-aliased
  assertEquals(r.mappings.length, 2);
  assertEquals(r.unmappedProjects, []);
});

Deno.test("deriveReference: dedups a member across projects, first crew wins", () => {
  const r = deriveReference(
    [
      {
        project: "team-a/repo",
        members: [{ username: "alice", name: "Alice Smith" }],
      },
      {
        project: "team-b/repo",
        members: [{ username: "alice", name: "Alice Smith" }],
      },
    ],
    [
      { project: "team-a/repo", crewId: "crew-alpha" },
      { project: "team-b/repo", crewId: "crew-beta" },
    ],
    [],
  );
  assertEquals(r.members.length, 1); // one alice
  assertEquals(r.members[0].crewId, "crew-alpha"); // first crewMap wins
});

Deno.test("deriveReference: reports projects with members but no crewMap entry", () => {
  const r = deriveReference(
    [
      {
        project: "team-a/repo",
        members: [{ username: "alice", name: "Alice" }],
      },
      { project: "orphan/repo", members: [{ username: "zoe", name: "Zoe" }] },
    ],
    [{ project: "team-a/repo", crewId: "crew-alpha" }],
    [],
  );
  assertEquals(r.members.length, 1); // only alice; zoe's project unmapped
  assertEquals(r.unmappedProjects, ["orphan/repo"]);
});

Deno.test("deriveReference: no display alias when name equals username", () => {
  const r = deriveReference(
    [{
      project: "team-a/repo",
      members: [{ username: "alice", name: "alice" }],
    }],
    [{ project: "team-a/repo", crewId: "crew-alpha" }],
    [],
  );
  assertEquals(r.members[0].aliases, []);
});

Deno.test("derive method writes the reference snapshot (valid, idempotent)", async () => {
  const { context, getWrittenResources } = ctx();
  await model.methods.derive.execute(
    {
      memberLists: [
        {
          project: "team-a/repo",
          members: [{ username: "alice", name: "Alice Smith" }],
        },
        {
          // members present but no crewMap entry -> a coverage gap
          project: "orphan/repo",
          members: [{ username: "zoe", name: "Zoe" }],
        },
      ],
      crewMap: [{ project: "team-a/repo", crewId: "crew-alpha" }],
      crewNames: [],
    },
    context as unknown as Parameters<typeof model.methods.derive.execute>[1],
  );
  const resources = getWrittenResources();
  assertEquals(resources[0].specName, "reference");
  assertEquals(resources[0].name, "reference-current");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals((data.members as unknown[]).length, 1); // only alice rostered
  assertEquals((data.crews as unknown[]).length, 1);
  // The coverage gap is persisted, not just logged — queryable via swamp data.
  assertEquals(data.unmappedProjects, ["orphan/repo"]);
});
