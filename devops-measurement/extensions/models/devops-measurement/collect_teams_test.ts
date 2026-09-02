// Teams collector tests.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model, translate } from "./collect_teams.ts";

const REF = {
  members: [
    { username: "alice", crewId: "crew-alpha", aliases: [] },
    { username: "bob", crewId: "crew-beta", aliases: [] },
  ],
  mappings: [{
    crewId: "crew-beta",
    mappingType: "channel",
    value: "chan-1",
  }],
};

Deno.test("teams: message with a mention makes helper->mentioned edge", () => {
  const { events } = translate({
    channels: [{
      channelId: "chan-1", // crew-beta channel
      messages: [{
        id: "m1",
        createdDateTime: "2026-08-01T00:00:00Z",
        from: { user: { id: "u-alice", displayName: "alice" } },
        mentions: [{
          mentioned: { user: { id: "u-bob", displayName: "bob" } },
        }],
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].eventType, "teams_message");
  assertEquals(events[0].sourceCrew, "crew-alpha");
  assertEquals(events[0].targetCrew, "crew-beta");
  assertEquals(events[0].targetUser, "bob");
});

Deno.test("teams: message with no mention still counts, no targetUser", () => {
  const { events } = translate({
    channels: [{
      channelId: "chan-1",
      messages: [{
        id: "m2",
        createdDateTime: "2026-08-01T00:00:00Z",
        from: { user: { id: "u-alice", displayName: "alice" } },
        mentions: [],
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].targetUser, "");
});

Deno.test("teams: system message (no sender) is skipped", () => {
  const { events } = translate({
    channels: [{
      channelId: "chan-1",
      messages: [{
        id: "m3",
        createdDateTime: "t",
        from: { user: null },
        mentions: [],
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 0);
});

Deno.test("teams: multiple mentions become distinct events", () => {
  const { events } = translate({
    channels: [{
      channelId: "chan-1",
      messages: [{
        id: "m4",
        createdDateTime: "2026-08-01T00:00:00Z",
        from: { user: { displayName: "alice" } },
        mentions: [
          { mentioned: { user: { id: "1", displayName: "bob" } } },
          { mentioned: { user: { id: "2", displayName: "carol" } } },
        ],
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 2);
  assertEquals(
    events.map((e) => e.eventId).length,
    new Set(events.map((e) => e.eventId)).size,
  );
});

Deno.test("teams: replies are activity too (reply sender helps the channel)", () => {
  const { events } = translate({
    channels: [{
      channelId: "chan-1", // crew-beta channel
      messages: [{
        id: "m1",
        createdDateTime: "2026-08-01T00:00:00Z",
        from: { user: { displayName: "bob" } }, // crew-beta member, own crew
        mentions: [],
        replies: [{
          id: "r1",
          createdDateTime: "2026-08-01T01:00:00Z",
          from: { user: { displayName: "alice" } }, // crew-alpha replies
          mentions: [],
        }],
      }],
    }],
    crewReference: REF,
  });
  // bob's root (same-crew) + alice's reply (cross-boundary) = 2 events
  assertEquals(events.length, 2);
  const reply = events.find((e) => e.userId === "alice")!;
  assertEquals(reply.sourceCrew, "crew-alpha");
  assertEquals(reply.targetCrew, "crew-beta");
});

Deno.test("teams sync writes teams-events", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.sync.execute(
    {
      channels: [{
        channelId: "chan-1",
        messages: [{
          id: "m1",
          createdDateTime: "2026-08-01T00:00:00Z",
          from: { user: { displayName: "alice" } },
          mentions: [],
        }],
      }],
      crewReference: REF,
    },
    context as unknown as Parameters<typeof model.methods.sync.execute>[1],
  );
  const r = getWrittenResources();
  assertEquals(r[0].name, "teams-events");
  assertEquals((r[0].data as Record<string, unknown>).source, "teams");
});
