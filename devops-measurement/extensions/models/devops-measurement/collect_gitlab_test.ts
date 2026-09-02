// GitLab collector tests — translation (the ACL) and the sync method.
// Consumes the FLAT @webframp/gitlab envelope shapes (option C):
//   mergeRequestLists: [{ project, mergeRequests[] }]
//   mrNotesLists:      [{ project, noteableIid, notes[] }]
//   commitLists:       [{ project, commits[] }]
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { buildLookups, model, translate } from "./collect_gitlab.ts";

const REF = {
  members: [
    {
      username: "alice",
      crewId: "crew-alpha",
      aliases: ["Alice Smith", "alice@x.org"],
    },
    { username: "bob", crewId: "crew-beta", aliases: [] },
    { username: "carol", crewId: "crew-beta", aliases: [] },
  ],
  mappings: [
    { crewId: "crew-beta", mappingType: "project", value: "100" },
    { crewId: "crew-alpha", mappingType: "project", value: "200" },
  ],
};

const EMPTY = { mergeRequestLists: [], mrNotesLists: [], commitLists: [] };

Deno.test("buildLookups resolves users and projects, empty for unknown", () => {
  const { userCrew, projectCrew } = buildLookups(REF);
  assertEquals(userCrew("alice"), "crew-alpha");
  assertEquals(userCrew("nobody"), "");
  assertEquals(projectCrew("100"), "crew-beta");
  assertEquals(projectCrew("999"), "");
});

Deno.test("translate: cross-boundary review (alice reviews crew-beta MR)", () => {
  const { events } = translate({
    ...EMPTY,
    mergeRequestLists: [{
      project: "100", // crew-beta owns it
      mergeRequests: [{
        iid: 5,
        author: { username: "bob" }, // crew-beta member
        updatedAt: "2026-04-10T00:00:00Z",
        mergedAt: "2026-04-10T06:00:00Z",
        approvers: ["alice"], // crew-alpha member reviews -> cross-boundary
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  const e = events[0];
  assertEquals(e.eventType, "mr_review");
  assertEquals(e.sourceCrew, "crew-alpha");
  assertEquals(e.targetCrew, "crew-beta");
  assertEquals(e.targetUser, "bob");
  assertEquals(e.timestamp, "2026-04-10T06:00:00Z"); // merge time preferred
  assertEquals(e.metadata.mergedAt, "2026-04-10T06:00:00Z");
  assertEquals(e.projectId, "100"); // threaded from the envelope
});

Deno.test("translate: same-crew review is NOT cross-boundary (still an event)", () => {
  const { events } = translate({
    ...EMPTY,
    mergeRequestLists: [{
      project: "100", // crew-beta
      mergeRequests: [{
        iid: 6,
        author: { username: "bob" },
        updatedAt: "2026-04-10T00:00:00Z",
        mergedAt: null,
        approvers: ["carol"], // crew-beta member reviews crew-beta MR
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].sourceCrew, "crew-beta");
  assertEquals(events[0].targetCrew, "crew-beta"); // same crew
  assertEquals(events[0].timestamp, "2026-04-10T00:00:00Z"); // no merge -> updatedAt
});

Deno.test("translate: DR-2 stable identity across re-observation with shifted updatedAt", () => {
  const mk = (updatedAt: string) =>
    translate({
      ...EMPTY,
      mergeRequestLists: [{
        project: "100",
        mergeRequests: [{
          iid: 5,
          author: { username: "bob" },
          updatedAt,
          mergedAt: null,
          approvers: ["alice"],
        }],
      }],
      crewReference: REF,
    }).events[0];

  const first = mk("2026-04-10T00:00:00Z");
  const later = mk("2026-04-17T09:00:00Z"); // MR updated again
  // Same review, so SAME eventId despite the moved updatedAt — versioned data
  // will dedup rather than double-count.
  assertEquals(first.eventId, later.eventId);
});

Deno.test("translate: comment attributes to note author, helped = MR author", () => {
  const { events } = translate({
    ...EMPTY,
    mergeRequestLists: [{
      project: "200", // crew-alpha owns it
      mergeRequests: [{
        iid: 9,
        author: { username: "alice" },
        updatedAt: "2026-04-01T00:00:00Z",
        mergedAt: null,
        approvers: [],
      }],
    }],
    mrNotesLists: [{
      project: "200",
      noteableIid: 9,
      notes: [{
        id: 5001,
        author: { username: "bob" }, // crew-beta member comments on crew-alpha MR
        body: "LGTM with a nit",
        createdAt: "2026-04-02T00:00:00Z",
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  const e = events[0];
  assertEquals(e.eventType, "mr_comment");
  assertEquals(e.sourceCrew, "crew-beta");
  assertEquals(e.targetCrew, "crew-alpha");
  assertEquals(e.targetUser, "alice"); // the MR author was helped
  assertEquals(e.projectId, "200"); // threaded from the envelope
});

Deno.test("translate: commit attributes to author, keyed by SHA", () => {
  const { events } = translate({
    ...EMPTY,
    commitLists: [{
      project: "100", // crew-beta
      commits: [{
        id: "deadbeef",
        authorName: "alice", // crew-alpha commits to crew-beta repo
        authorEmail: "alice@example.org",
        committedDate: "2026-04-05T00:00:00Z",
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  const e = events[0];
  assertEquals(e.eventType, "commit");
  assertEquals(e.sourceCrew, "crew-alpha");
  assertEquals(e.targetCrew, "crew-beta");
  assertEquals(e.targetUser, ""); // commit helps the crew, no single user
  assertEquals(e.userId, "alice"); // canonicalized to member username, not email
});

Deno.test("translate: git author alias resolves to canonical member username", () => {
  // A commit whose git author name is "Alice Smith" (an alias) must resolve to
  // the canonical member "alice" — so it does not fragment from her GitLab
  // review/comment identity.
  const { events } = translate({
    ...EMPTY,
    commitLists: [{
      project: "100",
      commits: [{
        id: "beef",
        authorName: "Alice Smith", // alias of alice
        authorEmail: "alice@x.org",
        committedDate: "2026-04-05T00:00:00Z",
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].userId, "alice"); // canonical, not "Alice Smith"
  assertEquals(events[0].sourceCrew, "crew-alpha");
});

Deno.test("translate: commit by a non-member falls back to email as id", () => {
  const { events, unresolvedCrews } = translate({
    ...EMPTY,
    commitLists: [{
      project: "100",
      commits: [{
        id: "cafe",
        authorName: "Outside Contributor",
        authorEmail: "outside@vendor.com",
        committedDate: "2026-04-05T00:00:00Z",
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].userId, "outside@vendor.com"); // unknown -> email
  assertEquals(events[0].sourceCrew, ""); // not a member -> unresolved source
  assertEquals(unresolvedCrews, 1);
});

Deno.test("translate: DR-5 counts unresolved crews (unknown user and project)", () => {
  const { events, unresolvedCrews } = translate({
    ...EMPTY,
    mergeRequestLists: [{
      project: "999", // unmapped project -> empty target crew
      mergeRequests: [{
        iid: 1,
        author: { username: "bob" },
        updatedAt: "2026-04-01T00:00:00Z",
        mergedAt: null,
        approvers: ["ghost"], // unknown user -> empty source crew
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(unresolvedCrews, 1); // both crews empty -> counted once
});

Deno.test("translate: notes across multiple MRs group by envelope (project,iid)", () => {
  // Two note envelopes for two different MRs in the same project — each note
  // must attribute to its own MR's author via the envelope's noteableIid.
  const { events } = translate({
    ...EMPTY,
    mergeRequestLists: [{
      project: "200",
      mergeRequests: [
        {
          iid: 9,
          author: { username: "alice" },
          updatedAt: "t",
          mergedAt: null,
          approvers: [],
        },
        {
          iid: 10,
          author: { username: "carol" },
          updatedAt: "t",
          mergedAt: null,
          approvers: [],
        },
      ],
    }],
    mrNotesLists: [
      {
        project: "200",
        noteableIid: 9,
        notes: [{
          id: 5002,
          author: { username: "bob" },
          body: "x",
          createdAt: "2026-04-02T00:00:00Z",
        }],
      },
      {
        project: "200",
        noteableIid: 10,
        notes: [{
          id: 5003,
          author: { username: "bob" },
          body: "y",
          createdAt: "2026-04-03T00:00:00Z",
        }],
      },
    ],
    crewReference: REF,
  });
  assertEquals(events.length, 2);
  const helped = events.map((e) => e.targetUser).sort();
  assertEquals(helped, ["alice", "carol"]); // each note -> its own MR author
});

Deno.test("sync writes the gitlab-events resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
  });
  await model.methods.sync.execute(
    {
      mergeRequestLists: [{
        project: "100",
        mergeRequests: [{
          iid: 5,
          author: { username: "bob" },
          updatedAt: "2026-04-10T00:00:00Z",
          mergedAt: "2026-04-10T06:00:00Z",
          approvers: ["alice"],
        }],
      }],
      mrNotesLists: [],
      commitLists: [],
      crewReference: REF,
    },
    context as unknown as Parameters<typeof model.methods.sync.execute>[1],
  );
  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].specName, "events");
  assertEquals(resources[0].name, "gitlab-events");
  const data = resources[0].data as Record<string, unknown>;
  assertEquals(data.count, 1);
  assertEquals(data.source, "gitlab");
  assertEquals(data.unresolvedCrews, 0);
});

// =============================================================================
// Regression tests for the pre-push-review findings.
// =============================================================================

// Fix 1 (CRITICAL): a commit author whose git EMAIL is a registered alias — but
// whose free-form git NAME is not — must still resolve to the canonical member,
// not fragment into a name-keyed identity. alice's REF alias is "alice@x.org".
Deno.test("translate: commit resolves member via email alias when name differs", () => {
  const { events, unresolvedCrews } = translate({
    ...EMPTY,
    commitLists: [{
      project: "100", // crew-beta owns it -> cross-boundary help by alice
      commits: [{
        id: "sha-email-alias",
        authorName: "A. Smith (laptop)", // NOT a known alias
        authorEmail: "alice@x.org", // IS alice's registered alias
        committedDate: "2026-04-06T00:00:00Z",
      }],
    }],
    crewReference: REF,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].userId, "alice"); // resolved to canonical member
  assertEquals(events[0].sourceCrew, "crew-alpha");
  assertEquals(events[0].targetCrew, "crew-beta");
  assertEquals(unresolvedCrews, 0);
});

// Fix 2 (HIGH): the mr_comment identity keys on the note's own stable id, not a
// positional index. list_mr_notes returns a sliding window (last N), so when an
// older note drops out of view the SAME surviving comment must keep its
// eventId. We prove it by observing the same note under two different window
// contents and asserting the eventId is identical.
Deno.test("translate: mr_comment eventId is stable across a sliding note window", () => {
  const mergeRequestLists = [{
    project: "200", // crew-alpha owns it
    mergeRequests: [{
      iid: 9,
      author: { username: "alice" },
      updatedAt: "2026-04-01T00:00:00Z",
      mergedAt: null,
      approvers: [],
    }],
  }];
  // Window A: two notes, the target note (id 7002) is second.
  const a = translate({
    ...EMPTY,
    mergeRequestLists,
    mrNotesLists: [{
      project: "200",
      noteableIid: 9,
      notes: [
        {
          id: 7001,
          author: { username: "bob" },
          body: "first",
          createdAt: "2026-04-02T00:00:00Z",
        },
        {
          id: 7002,
          author: { username: "bob" },
          body: "second",
          createdAt: "2026-04-03T00:00:00Z",
        },
      ],
    }],
    crewReference: REF,
  });
  // Window B: the older note (7001) has scrolled out; 7002 is now first.
  const b = translate({
    ...EMPTY,
    mergeRequestLists,
    mrNotesLists: [{
      project: "200",
      noteableIid: 9,
      notes: [
        {
          id: 7002,
          author: { username: "bob" },
          body: "second",
          createdAt: "2026-04-03T00:00:00Z",
        },
        {
          id: 7003,
          author: { username: "bob" },
          body: "third",
          createdAt: "2026-04-04T00:00:00Z",
        },
      ],
    }],
    crewReference: REF,
  });
  const idA =
    a.events.find((e) => e.timestamp === "2026-04-03T00:00:00Z")!.eventId;
  const idB =
    b.events.find((e) => e.timestamp === "2026-04-03T00:00:00Z")!.eventId;
  assertEquals(idA, idB); // same note id -> same eventId regardless of position
});

// Fix 3 (MEDIUM): the same commit SHA can appear under two projects (fork /
// cherry-pick). Keying the event identity on SHA alone would dedup them to the
// first-seen project's crew. Project + SHA must keep them distinct.
Deno.test("translate: same commit SHA in two projects yields distinct events", () => {
  const { events } = translate({
    ...EMPTY,
    commitLists: [
      {
        project: "100",
        commits: [{
          id: "shared-sha",
          authorName: "alice",
          authorEmail: "alice@x.org",
          committedDate: "2026-04-07T00:00:00Z",
        }],
      },
      {
        project: "200",
        commits: [{
          id: "shared-sha",
          authorName: "alice",
          authorEmail: "alice@x.org",
          committedDate: "2026-04-07T00:00:00Z",
        }],
      },
    ],
    crewReference: REF,
  });
  assertEquals(events.length, 2);
  const ids = new Set(events.map((e) => e.eventId));
  assertEquals(ids.size, 2); // distinct identities, not deduped
  const targets = events.map((e) => e.targetCrew).sort();
  assertEquals(targets, ["crew-alpha", "crew-beta"]); // each keeps its project crew
});
