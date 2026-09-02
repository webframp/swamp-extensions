// Shared kernel tests — event factory, cross-boundary predicate, deterministic id.
// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.19";
import {
  canonicalActor,
  DEFAULT_WEIGHTS,
  eventId,
  type EventType,
  isCrossBoundary,
  newEvent,
} from "./event.ts";

Deno.test("isCrossBoundary requires both crews present and different", () => {
  assertEquals(isCrossBoundary("a", "b"), true);
  assertEquals(isCrossBoundary("a", "a"), false); // same crew
  assertEquals(isCrossBoundary("", "b"), false); // no source
  assertEquals(isCrossBoundary("a", ""), false); // no target (e.g. CloudTrail)
  assertEquals(isCrossBoundary("", ""), false);
});

Deno.test("eventId is deterministic for the same identity parts", () => {
  const a = eventId("proj-1", 42, "user-7", "mr_review");
  const b = eventId("proj-1", 42, "user-7", "mr_review");
  assertEquals(a, b);
});

Deno.test("eventId differs when any identity part differs", () => {
  const base = eventId("proj-1", 42, "user-7", "mr_review");
  assertNotEquals(base, eventId("proj-1", 42, "user-8", "mr_review"));
  assertNotEquals(base, eventId("proj-1", 43, "user-7", "mr_review"));
  assertNotEquals(base, eventId("proj-2", 42, "user-7", "mr_review"));
  assertNotEquals(base, eventId("proj-1", 42, "user-7", "mr_comment"));
});

Deno.test("eventId does not collide on adjacent concatenations (delimiter safety)", () => {
  // Without a delimiter, ("ab","c") and ("a","bc") would hash identically.
  assertNotEquals(eventId("ab", "c"), eventId("a", "bc"));
});

Deno.test("newEvent identity is stable across mutable-field changes (DR-2)", () => {
  // The core DR-2 guarantee: re-observing the same review with a shifted
  // timestamp (the MR's updatedAt moved) must produce the SAME eventId, so
  // versioned data dedups instead of double-counting.
  const identity = ["proj-1", 42, "user-7", "mr_review"];
  const first = newEvent({
    userId: "user-7",
    username: "alice",
    eventType: "mr_review",
    sourceCrew: "crew-alpha",
    targetCrew: "crew-beta",
    targetUser: "bob",
    projectId: "proj-1",
    timestamp: "2026-04-01T00:00:00Z",
    metadata: { mergedAt: "2026-04-02T00:00:00Z" },
  }, identity);

  const reobserved = newEvent({
    userId: "user-7",
    username: "alice",
    eventType: "mr_review",
    sourceCrew: "crew-alpha",
    targetCrew: "crew-beta",
    targetUser: "bob",
    // timestamp shifted (MR updated again), metadata changed — identity holds
    timestamp: "2026-04-08T12:00:00Z",
    metadata: { mergedAt: "2026-04-02T00:00:00Z", note: "re-run" },
  }, identity);

  assertEquals(first.eventId, reobserved.eventId);
});

Deno.test("newEvent applies defaults for optional fields", () => {
  const e = newEvent({
    userId: "u1",
    username: "svc",
    eventType: "cloudtrail",
    sourceCrew: "crew-beta",
    projectId: "ec2.amazonaws.com",
    timestamp: "2026-04-01T00:00:00Z",
  }, ["ec2.amazonaws.com", "u1", "cloudtrail", "2026-04-01T00:00:00Z"]);

  assertEquals(e.targetCrew, ""); // CloudTrail: breadth, never cross-crew
  assertEquals(e.targetUser, "");
  assertEquals(e.metadata, {});
  assertEquals(isCrossBoundary(e.sourceCrew, e.targetCrew), false);
});

Deno.test("DEFAULT_WEIGHTS matches the Go config exactly", () => {
  const expected: Record<EventType, number> = {
    mr_review: 3,
    mr_comment: 1,
    commit: 4,
    teams_message: 1,
    redmine_comment: 2,
    cloudtrail: 1,
  };
  assertEquals({ ...DEFAULT_WEIGHTS }, expected);
});

Deno.test("canonicalActor resolves aliases to the canonical username", () => {
  const aliases = new Map<string, string>([
    ["alice", "alice"],
    ["Alice Smith", "alice"],
    ["alice@corp.com", "alice"],
  ]);
  assertEquals(canonicalActor("Alice Smith", aliases), "alice");
  assertEquals(canonicalActor("alice@corp.com", aliases), "alice");
  assertEquals(canonicalActor("alice", aliases), "alice");
  // unknown identifier returned unchanged
  assertEquals(canonicalActor("stranger", aliases), "stranger");
});
