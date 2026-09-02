// CloudTrail collector tests.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { isCrossBoundary } from "./_lib/event.ts";
import { model, translate } from "./collect_cloudtrail.ts";

const REF = {
  members: [{ username: "alice", crewId: "crew-alpha", aliases: [] }],
};

Deno.test("cloudtrail: write event maps with EMPTY target crew (breadth rule)", () => {
  const { events } = translate({
    events: [{
      username: "alice",
      eventSource: "ec2.amazonaws.com",
      eventName: "RunInstances",
      eventTime: "2026-08-01T00:00:00Z",
      readOnly: false,
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].sourceCrew, "crew-alpha");
  assertEquals(events[0].targetCrew, ""); // ALWAYS empty
  assertEquals(events[0].projectId, "ec2.amazonaws.com"); // service = breadth
  // The encoded rule: a CloudTrail event can NEVER be cross-boundary.
  assertEquals(
    isCrossBoundary(events[0].sourceCrew, events[0].targetCrew),
    false,
  );
});

Deno.test("cloudtrail: read-only events are dropped", () => {
  const { events } = translate({
    events: [{
      username: "alice",
      eventSource: "s3.amazonaws.com",
      eventName: "GetObject",
      eventTime: "t",
      readOnly: true,
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 0);
});

Deno.test("cloudtrail: distinct services are distinct events (breadth)", () => {
  const { events } = translate({
    events: [
      {
        username: "alice",
        eventSource: "ec2.amazonaws.com",
        eventName: "RunInstances",
        eventTime: "2026-08-01T00:00:00Z",
        readOnly: false,
      },
      {
        username: "alice",
        eventSource: "s3.amazonaws.com",
        eventName: "PutObject",
        eventTime: "2026-08-01T00:00:00Z",
        readOnly: false,
      },
    ],
    crewReference: REF,
  });
  assertEquals(events.length, 2);
  assertEquals(new Set(events.map((e) => e.projectId)).size, 2);
});

Deno.test("cloudtrail: unknown user counted as unresolved source", () => {
  const { events, unresolvedCrews } = translate({
    events: [{
      username: "ghost",
      eventSource: "ec2.amazonaws.com",
      eventName: "RunInstances",
      eventTime: "t",
      readOnly: false,
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(unresolvedCrews, 1);
});

Deno.test("cloudtrail sync writes cloudtrail-events", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.sync.execute(
    {
      events: [{
        username: "alice",
        eventSource: "ec2.amazonaws.com",
        eventName: "RunInstances",
        eventTime: "2026-08-01T00:00:00Z",
        readOnly: false,
      }],
      crewReference: REF,
    },
    context as unknown as Parameters<typeof model.methods.sync.execute>[1],
  );
  const r = getWrittenResources();
  assertEquals(r[0].name, "cloudtrail-events");
  assertEquals((r[0].data as Record<string, unknown>).source, "cloudtrail");
});
