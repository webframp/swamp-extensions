import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { extension } from "./triage.ts";

const project = "group/repo";
const iid = 4;
const storedResources = {
  [`mrDiff-${encodeURIComponent(project)}-${iid}`]: {
    project,
    iid,
    state: "opened",
    diffs: [{ newPath: "src/example.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
  },
};

Deno.test("post_inline_review rejects stale MR heads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify([{
          base_commit_sha: "base",
          start_commit_sha: "start",
          head_commit_sha: "different-head",
        }]),
        { status: 200 },
      ),
    );
  const { context } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
    storedResources,
  });
  try {
    await assertRejects(
      () =>
        extension.methods.post_inline_review.execute({
          project,
          iid,
          expectedHeadSha: "expected-head",
          action: "comment",
          comments: [{
            path: "src/example.ts",
            newLine: 1,
            body: "Review note",
          }],
        }, context as never),
      Error,
      "head SHA changed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("post_inline_review validates changed lines and records discussions", async () => {
  const originalFetch = globalThis.fetch;
  let discussionBody: Record<string, unknown> | undefined;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/versions")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            base_commit_sha: "base",
            start_commit_sha: "start",
            head_commit_sha: "expected-head",
          }]),
          { status: 200 },
        ),
      );
    }
    discussionBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: "discussion-1",
          notes: [{ id: 10 }],
        }),
        { status: 201 },
      ),
    );
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { host: "gitlab.example.com", token: "test-token" },
    storedResources,
  });
  try {
    await extension.methods.post_inline_review.execute({
      project,
      iid,
      expectedHeadSha: "expected-head",
      action: "comment",
      comments: [{ path: "src/example.ts", newLine: 1, body: "Review note" }],
    }, context as never);
    assertEquals(discussionBody?.body, "Review note");
    assertEquals(getWrittenResources()[0].data, {
      project,
      iid,
      expectedHeadSha: "expected-head",
      action: "comment",
      discussions: [{
        discussionId: "discussion-1",
        noteId: 10,
        path: "src/example.ts",
        newLine: 1,
      }],
      postedAt:
        (getWrittenResources()[0].data as { postedAt: string }).postedAt,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
