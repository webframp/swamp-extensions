// Redmine collector tests — consumes @webframp/redmine get_issue detail records
// (self-contained: project:{id,name}, author:{id,name}, journals[]).
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model, translate } from "./collect_redmine.ts";

const REF = {
  members: [
    // Redmine identifies people by display NAME; aliases map name -> username.
    {
      username: "alice",
      crewId: "crew-alpha",
      aliases: ["Alice Smith"],
    },
    { username: "bob", crewId: "crew-beta", aliases: ["Bob Jones"] },
  ],
  mappings: [{ crewId: "crew-beta", mappingType: "project", value: "50" }],
};

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    project: { id: 50, name: "Alpha Project" }, // crew-beta owns project 50
    author: { id: 2, name: "Bob Jones" }, // issue author (helped), alias of bob
    createdOn: "2026-08-01T00:00:00Z",
    journals: [],
    ...over,
  };
}

Deno.test("redmine: journal note becomes a cross-boundary comment", () => {
  const { events } = translate({
    issues: [issue({
      journals: [{
        id: 1,
        user: { id: 3, name: "Alice Smith" }, // crew-alpha comments (alias)
        notes: "Have you tried X?",
        createdOn: "2026-08-01T04:00:00Z",
      }],
    })],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].eventType, "redmine_comment");
  assertEquals(events[0].sourceCrew, "crew-alpha");
  assertEquals(events[0].targetCrew, "crew-beta");
  assertEquals(events[0].targetUser, "bob"); // author.name "Bob Jones" -> bob
  assertEquals(events[0].userId, "alice"); // user.name "Alice Smith" -> alice
  assertEquals(events[0].projectId, "50"); // project.id number -> string
});

Deno.test("redmine: empty-note journals are dropped", () => {
  const { events } = translate({
    issues: [issue({
      journals: [
        {
          id: 1,
          user: { id: 3, name: "Alice Smith" },
          notes: "",
          createdOn: "2026-08-01T01:00:00Z",
        },
        {
          id: 2,
          user: { id: 3, name: "Alice Smith" },
          notes: "real",
          createdOn: "2026-08-01T02:00:00Z",
        },
      ],
    })],
    crewReference: REF,
  });
  assertEquals(events.length, 1); // the empty-note journal dropped
});

Deno.test("redmine: first response carries taggedAt/respondedAt timing", () => {
  const { events } = translate({
    issues: [issue({
      journals: [
        {
          id: 5,
          user: { id: 3, name: "Alice Smith" },
          notes: "first",
          createdOn: "2026-08-01T03:00:00Z",
        },
        {
          id: 6,
          user: { id: 3, name: "Alice Smith" },
          notes: "second",
          createdOn: "2026-08-02T00:00:00Z",
        },
      ],
    })],
    crewReference: REF,
  });
  const first = events.find((e) =>
    (e.metadata as Record<string, unknown>).taggedAt
  );
  assertEquals(
    (first!.metadata as Record<string, unknown>).taggedAt,
    "2026-08-01T00:00:00Z",
  );
  assertEquals(
    (first!.metadata as Record<string, unknown>).respondedAt,
    "2026-08-01T03:00:00Z",
  );
  const second = events.filter((e) =>
    !(e.metadata as Record<string, unknown>).taggedAt
  );
  assertEquals(second.length, 1);
});

Deno.test("redmine sync writes redmine-events", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.sync.execute(
    {
      issues: [issue({
        journals: [{
          id: 1,
          user: { id: 3, name: "Alice Smith" },
          notes: "x",
          createdOn: "2026-08-01T04:00:00Z",
        }],
      })],
      crewReference: REF,
    },
    context as unknown as Parameters<typeof model.methods.sync.execute>[1],
  );
  const r = getWrittenResources();
  assertEquals(r[0].name, "redmine-events");
  assertEquals((r[0].data as Record<string, unknown>).source, "redmine");
});
