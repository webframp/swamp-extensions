import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./lab.ts";

const globalArgs = {
  host: "swamp-club.com",
  apiKey: "test-key",
  maxComments: 1,
};

Deno.test("Lab adapter exposes only the required scoped methods", () => {
  assertEquals(Object.keys(model.methods).sort(), [
    "get_lab_issue_context",
    "post_ripple",
  ]);
});

Deno.test("get_lab_issue_context bounds comments and reports truncation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          issue: {
            type: "bug",
            status: "open",
            title: "Example",
            body: "Details",
            authorUsername: "reporter",
            comments: [
              { authorUsername: "first", body: "one", createdAt: "2026-09-01" },
              { authorUsername: "last", body: "two", createdAt: "2026-09-02" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  try {
    await model.methods.get_lab_issue_context.execute(
      { issueNumber: 12 },
      context as never,
    );
    const data = getWrittenResources()[0].data as {
      truncated: boolean;
      comments: Array<{ author: string; body: string; createdAt: string }>;
    };
    assertEquals(data.truncated, true);
    assertEquals(data.comments, [{
      author: "last",
      body: "two",
      createdAt: "2026-09-02",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("get_lab_issue_context strips an http:// prefix from a misconfigured host", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (input: string | URL | Request) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          issue: {
            type: "bug",
            status: "open",
            title: "Example",
            body: "Details",
            authorUsername: "reporter",
            comments: [],
          },
        }),
        { status: 200 },
      ),
    );
  };
  const { context } = createModelTestContext({
    globalArgs: { ...globalArgs, host: "http://swamp-club.com" },
  });
  try {
    await model.methods.get_lab_issue_context.execute(
      { issueNumber: 12 },
      context as never,
    );
    assertEquals(
      requestedUrl.startsWith("https://swamp-club.com/api/v1/"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("post_ripple sends the exact idempotency marker and records comment ID", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body);
    return Promise.resolve(
      new Response(JSON.stringify({ comment: { id: "comment-9" } }), {
        status: 201,
      }),
    );
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  try {
    await model.methods.post_ripple.execute({
      issueNumber: 12,
      body:
        "Linked issue: https://github.com/webframp/swamp-extensions/issues/1",
      idempotencyKey: "ripple-12",
    }, context as never);
    assertEquals(
      requestBody,
      JSON.stringify({
        body:
          "Linked issue: https://github.com/webframp/swamp-extensions/issues/1\n\n<!-- triage:ripple-12 -->",
      }),
    );
    assertEquals(
      (getWrittenResources()[0].data as { commentId: string }).commentId,
      "comment-9",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
