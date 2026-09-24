// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  createModelTestContext,
  withMockedFetch,
} from "@swamp-club/swamp-testing";
import { extension } from "./typesafe_triage.ts";

type TriageContext = Parameters<
  (typeof extension.methods)[0]["triage_batch"]["execute"]
>[1];

const globalArgs = {
  apiKey: "test-key",
  model: "jev-latest",
  baseUrl: "https://typesafe.example.test",
  timeoutMs: 1_000,
};

function context(globalArgOverrides: Record<string, unknown> = {}) {
  const result = createModelTestContext({
    globalArgs: { ...globalArgs, ...globalArgOverrides },
    methodName: "triage_batch",
  });
  return {
    context: result.context as unknown as TriageContext,
    getWrittenResources: result.getWrittenResources,
  };
}

function response(noul: number): Response {
  return Response.json({
    model: "jev-latest",
    answers: { reply_needed: { type: "noul", noul } },
    usage: { input_tokens: 12, output_tokens: 3 },
  });
}

Deno.test("triage_batch writes one source-scoped batch without raw item state", async () => {
  const { context: testContext, getWrittenResources } = context();
  const { calls } = await withMockedFetch(
    [response(0.9), response(0.1)],
    () =>
      extension.methods[0].triage_batch.execute({
        items: [
          { id: "group/project!1", state: { title: "Review this" } },
          { id: "group/project!2", state: { title: "No action" } },
        ],
        questions: {
          reply_needed: { type: "noul", instructions: "Need review?" },
        },
        name: "daily",
        concurrency: 1,
      }, testContext),
  );

  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, "https://typesafe.example.test/v1/systemone");
  const written = getWrittenResources();
  assertEquals(written.length, 1);
  assertEquals(written[0].specName, "triageBatch");
  assertEquals(written[0].name, "triage-batch-daily");
  assertEquals(
    written[0].data.sourceFingerprint,
    "sha256-2806828aea3274a41cdc091c1a170505b1f3859dba9190152801cde313fefd61",
  );
  assertEquals(written[0].data.totalInputTokens, 24);
  assertEquals(written[0].data.totalOutputTokens, 6);
  assertEquals(written[0].data.results, [
    {
      id: "group/project!1",
      answers: { reply_needed: { type: "noul", noul: 0.9 } },
    },
    {
      id: "group/project!2",
      answers: { reply_needed: { type: "noul", noul: 0.1 } },
    },
  ]);
  assertEquals("state" in written[0].data, false);
  assertEquals("questions" in written[0].data, false);
});

Deno.test("triage_batch isolates an item failure and returns a usable batch", async () => {
  const { context: testContext, getWrittenResources } = context({
    maxRetries: 0,
  });
  await withMockedFetch(
    [response(0.9), new Response("unavailable", { status: 503 })],
    () =>
      extension.methods[0].triage_batch.execute({
        items: [{ id: "one", state: "a" }, { id: "two", state: "b" }],
        questions: {
          reply_needed: { type: "noul", instructions: "Need review?" },
        },
        name: "latest",
        concurrency: 1,
      }, testContext),
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.results, [
    { id: "one", answers: { reply_needed: { type: "noul", noul: 0.9 } } },
  ]);
  assertEquals(data.failures, [{
    id: "two",
    reason: "evaluation unavailable",
  }]);
});

Deno.test("triage_batch retries a transient provider response", async () => {
  const { context: testContext, getWrittenResources } = context({
    maxRetries: 1,
  });
  const { calls } = await withMockedFetch(
    [
      new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
      response(0.9),
    ],
    () =>
      extension.methods[0].triage_batch.execute({
        items: [{ id: "one", state: "a" }],
        questions: {
          reply_needed: { type: "noul", instructions: "Need review?" },
        },
        name: "retry",
        concurrency: 1,
      }, testContext),
  );
  assertEquals(calls.length, 2);
  assertEquals(getWrittenResources()[0].data.failures, []);
});

Deno.test("triage_batch marks incomplete typed answers as an item failure", async () => {
  const { context: testContext, getWrittenResources } = context({
    maxRetries: 0,
  });
  await withMockedFetch(
    [response(0.9)],
    () =>
      extension.methods[0].triage_batch.execute({
        items: [{ id: "one", state: "a" }],
        questions: {
          reply_needed: { type: "noul", instructions: "Need review?" },
          urgency: {
            type: "score",
            instructions: "Urgency?",
            criteria: ["low", "high"],
          },
        },
        name: "incomplete",
        concurrency: 1,
      }, testContext),
  );
  const data = getWrittenResources()[0].data;
  assertEquals(data.results, []);
  assertEquals(data.failures, [{
    id: "one",
    reason: "evaluation unavailable",
  }]);
});

Deno.test("triage_batch accepts the official TYPESAFE_API_KEY fallback", async () => {
  const before = Deno.env.get("TYPESAFE_API_KEY");
  try {
    Deno.env.set("TYPESAFE_API_KEY", "environment-key");
    const { context: testContext, getWrittenResources } = context({
      apiKey: undefined,
      maxRetries: 0,
    });
    await withMockedFetch(
      [response(0.9)],
      () =>
        extension.methods[0].triage_batch.execute({
          items: [{ id: "one", state: "a" }],
          questions: {
            reply_needed: { type: "noul", instructions: "Need review?" },
          },
          name: "env-key",
          concurrency: 1,
        }, testContext),
    );
    assertEquals(getWrittenResources()[0].data.failures, []);
  } finally {
    if (before === undefined) Deno.env.delete("TYPESAFE_API_KEY");
    else Deno.env.set("TYPESAFE_API_KEY", before);
  }
});

Deno.test("triage_batch rejects duplicate item ids before making a request", () => {
  const parsed = extension.methods[0].triage_batch.arguments.safeParse({
    items: [{ id: "same", state: "a" }, { id: "same", state: "b" }],
    questions: { q: { type: "noul", instructions: "?" } },
  });
  assertEquals(parsed.success, false);
});
