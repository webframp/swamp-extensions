import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  BlobClient,
  type BlobResponse,
  buildStringToSign,
  deadlineForBytes,
  isBlobAlreadyExists,
  MIN_THROUGHPUT_BYTES_PER_SEC,
  parseConnectionString,
} from "./rest_client.ts";
import { retryableRequest } from "./_lib/retry.ts";

// Known-good vector adapted from Microsoft's published Shared Key signing
// example (Azure Storage REST API — "Authorize with Shared Key"):
//   GET https://myaccount.blob.core.windows.net/mycontainer/myblob
//   x-ms-date: Wed, 23 Sep 2009 20:51:47 GMT
//   x-ms-version: 2009-09-19
Deno.test("buildStringToSign matches Microsoft's published Shared Key example", () => {
  const headers = new Headers({
    "x-ms-date": "Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-version": "2009-09-19",
  });
  const stringToSign = buildStringToSign(
    "myaccount",
    "GET",
    "/mycontainer/myblob",
    headers,
    0,
  );
  const expected = "GET\n\n\n\n\n\n\n\n\n\n\n\n" +
    "x-ms-date:Wed, 23 Sep 2009 20:51:47 GMT\n" +
    "x-ms-version:2009-09-19\n" +
    "/myaccount/mycontainer/myblob";
  assertEquals(stringToSign, expected);
});

Deno.test("buildStringToSign sorts x-ms- headers lexicographically", () => {
  const headers = new Headers({
    "x-ms-version": "2021-08-06",
    "x-ms-date": "Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-lease-id": "abc-123",
  });
  const stringToSign = buildStringToSign(
    "myaccount",
    "PUT",
    "/mycontainer/myblob",
    headers,
    0,
  );
  const headerLines = stringToSign.split("\n").filter((l) =>
    l.startsWith("x-ms-")
  );
  assertEquals(headerLines, [
    "x-ms-date:Wed, 23 Sep 2009 20:51:47 GMT",
    "x-ms-lease-id:abc-123",
    "x-ms-version:2021-08-06",
  ]);
});

Deno.test("buildStringToSign includes non-zero content-length", () => {
  const headers = new Headers({ "x-ms-date": "d", "x-ms-version": "v" });
  const stringToSign = buildStringToSign(
    "myaccount",
    "PUT",
    "/mycontainer/myblob",
    headers,
    42,
  );
  const contentLengthField = stringToSign.split("\n")[3];
  assertEquals(contentLengthField, "42");
});

Deno.test("buildStringToSign sorts distinct query params by key", () => {
  const headers = new Headers({ "x-ms-date": "d", "x-ms-version": "v" });
  const stringToSign = buildStringToSign(
    "myaccount",
    "GET",
    "/mycontainer/myblob?comp=metadata&timeout=30",
    headers,
    0,
  );
  const resourceLines = stringToSign.split("\n").slice(-3);
  assertEquals(resourceLines, [
    "/myaccount/mycontainer/myblob",
    "comp:metadata",
    "timeout:30",
  ]);
});

Deno.test("buildStringToSign sorts repeated values for the same query key lexicographically", () => {
  const headers = new Headers({ "x-ms-date": "d", "x-ms-version": "v" });
  // Values deliberately out of order in the query string ("b" before "a") —
  // Azure's spec requires them sorted before comma-joining, regardless of
  // the order they appeared in the request.
  const stringToSign = buildStringToSign(
    "myaccount",
    "GET",
    "/mycontainer?comp=list&include=b&include=a",
    headers,
    0,
  );
  const resourceLines = stringToSign.split("\n").slice(-3);
  assertEquals(resourceLines, [
    "/myaccount/mycontainer",
    "comp:list",
    "include:a,b",
  ]);
});

Deno.test("parseConnectionString extracts account name/key/endpoint suffix", () => {
  const parsed = parseConnectionString(
    "DefaultEndpointsProtocol=https;AccountName=myaccount;AccountKey=c3VwZXJzZWNyZXQ=;EndpointSuffix=core.windows.net",
  );
  assertEquals(parsed.accountName, "myaccount");
  assertEquals(parsed.accountKey, "c3VwZXJzZWNyZXQ=");
  assertEquals(parsed.endpointSuffix, "core.windows.net");
});

Deno.test("parseConnectionString defaults endpointSuffix when absent", () => {
  const parsed = parseConnectionString(
    "AccountName=myaccount;AccountKey=c3VwZXJzZWNyZXQ=",
  );
  assertEquals(parsed.endpointSuffix, "core.windows.net");
});

Deno.test("parseConnectionString throws when AccountKey is missing", () => {
  assertThrows(
    () => parseConnectionString("AccountName=myaccount"),
    Error,
    "AccountName and AccountKey",
  );
});

function blobResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): BlobResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
  };
}

Deno.test("isBlobAlreadyExists matches 409 by error-code header or body, and nothing else", () => {
  assertEquals(
    isBlobAlreadyExists(
      blobResponse(409, "", { "x-ms-error-code": "BlobAlreadyExists" }),
    ),
    true,
  );
  assertEquals(
    isBlobAlreadyExists(blobResponse(409, "<Code>BlobAlreadyExists</Code>")),
    true,
  );
  assertEquals(
    isBlobAlreadyExists(
      blobResponse(409, "", { "x-ms-error-code": "LeaseAlreadyPresent" }),
    ),
    false,
  );
  assertEquals(
    isBlobAlreadyExists(blobResponse(412, "BlobAlreadyExists")),
    false,
  );
  assertEquals(isBlobAlreadyExists(blobResponse(201, "")), false);
});

const SHARED_KEY_AUTH = {
  mode: "connectionString" as const,
  connectionString:
    "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net",
};

Deno.test("BlobClient.request aborts a stalled fetch with TimeoutError once the deadline passes", async () => {
  let sawSignal = false;
  const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) => {
    sawSignal = init?.signal != null;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, hangingFetch, 20);
  const err = await assertRejects(() =>
    client.request({ method: "GET", path: "/c/b" })
  );
  assertEquals(sawSignal, true);
  assertEquals((err as DOMException).name, "TimeoutError");
});

Deno.test("BlobClient.request propagates a caller abort as AbortError, not TimeoutError", async () => {
  const hangingFetch =
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Real fetch rejects immediately for an already-aborted signal.
        if (init?.signal?.aborted) return reject(init.signal.reason);
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      })) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, hangingFetch, 60_000);
  const controller = new AbortController();
  const pending = assertRejects(() =>
    client.request({ method: "GET", path: "/c/b", signal: controller.signal })
  );
  controller.abort();
  const err = await pending;
  assertEquals((err as DOMException).name, "AbortError");
});

Deno.test("BlobClient.request bounds a stalled response body read", async () => {
  const stallingBody = ((_url: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(init.signal!.reason),
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, stallingBody, 20);
  const err = await assertRejects(() =>
    client.request({ method: "GET", path: "/c/b" })
  );
  assertEquals((err as DOMException).name, "TimeoutError");
});

Deno.test("service-principal token exchange carries a deadline signal", async () => {
  const seen: Array<{ url: string; hasSignal: boolean }> = [];
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, hasSignal: init?.signal != null });
    if (new URL(u).hostname === "login.microsoftonline.com") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("", { status: 200 }));
  }) as typeof fetch;
  const client = BlobClient.fromAuth({
    mode: "servicePrincipal",
    accountName: "acct",
    endpointSuffix: "core.windows.net",
    tenantId: `tenant-${crypto.randomUUID()}`,
    clientId: "cid",
    clientSecret: "secret",
  }, fakeFetch);
  await client.request({ method: "GET", path: "/c/b" });
  assertEquals(seen.length, 2);
  assertEquals(seen.every((s) => s.hasSignal), true);
});

Deno.test("deadlineForBytes adds a transfer allowance per MIN_THROUGHPUT of payload", () => {
  assertEquals(deadlineForBytes(120_000, 0), 120_000);
  assertEquals(deadlineForBytes(120_000, 1), 121_000);
  assertEquals(
    deadlineForBytes(120_000, 100 * MIN_THROUGHPUT_BYTES_PER_SEC),
    220_000,
  );
});

Deno.test("an upload with a body gets a deadline longer than the base", async () => {
  // base 20 ms; a 1-byte body earns +1 s, so a 100 ms response must succeed.
  const slowOk =
    (() =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response("", { status: 201 })), 100)
      )) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, slowOk, 20);
  const resp = await client.request({
    method: "PUT",
    path: "/c/b",
    body: new Uint8Array([1]),
  });
  assertEquals(resp.status, 201);
});

Deno.test("a bodyless request is held to the base deadline", async () => {
  const slowOk =
    ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(
          () => resolve(new Response("", { status: 200 })),
          500,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason);
        }, { once: true });
      })) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, slowOk, 20);
  const err = await assertRejects(() =>
    client.request({ method: "GET", path: "/c/b" })
  );
  assertEquals((err as DOMException).name, "TimeoutError");
});

Deno.test("a per-request timeoutMs tightens but never extends the client deadline", async () => {
  const hanging =
    ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      })) as typeof fetch;
  const started = Date.now();
  const tight = BlobClient.fromAuth(SHARED_KEY_AUTH, hanging, 60_000);
  await assertRejects(() =>
    tight.request({ method: "GET", path: "/c/b", timeoutMs: 20 })
  );
  assertEquals(Date.now() - started < 5_000, true);

  const capped = BlobClient.fromAuth(SHARED_KEY_AUTH, hanging, 20);
  await assertRejects(() =>
    capped.request({ method: "GET", path: "/c/b", timeoutMs: 600_000 })
  );
});

Deno.test("a stalled service-principal token endpoint times out", async () => {
  const fakeFetch =
    ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
          { once: true },
        );
      })) as typeof fetch;
  const client = BlobClient.fromAuth(
    {
      mode: "servicePrincipal",
      accountName: "acct",
      endpointSuffix: "core.windows.net",
      tenantId: `tenant-${crypto.randomUUID()}`,
      clientId: "cid",
      clientSecret: "secret",
    },
    fakeFetch,
    20,
  );
  const err = await assertRejects(() =>
    client.request({ method: "GET", path: "/c/b" })
  );
  assertEquals((err as DOMException).name, "TimeoutError");
});

Deno.test("retryableRequest through BlobClient recovers when the first fetch stalls", async () => {
  let calls = 0;
  const flaky = ((_u: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls > 1) return Promise.resolve(new Response("", { status: 200 }));
    return new Promise<Response>((_res, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal!.reason),
        { once: true },
      );
    });
  }) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, flaky, 20);
  const resp = await retryableRequest(
    () => client.request({ method: "GET", path: "/c/b" }),
    { baseDelayMs: 1 },
  );
  assertEquals(resp.status, 200);
  assertEquals(calls, 2);
});

Deno.test("a download's body deadline is re-armed from Content-Length", async () => {
  // base 20 ms; Content-Length of 1 MiB earns +2 s, so a 100 ms body succeeds.
  const slowBody = ((_u: string | URL | Request, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const t = setTimeout(() => {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }, 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          controller.error(init.signal!.reason);
        }, { once: true });
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-length": String(1024 * 1024) },
      }),
    );
  }) as typeof fetch;
  const client = BlobClient.fromAuth(SHARED_KEY_AUTH, slowBody, 20);
  const resp = await client.request({ method: "GET", path: "/c/b" });
  assertEquals(resp.body.byteLength, 1);
});

Deno.test("an out-of-range timeoutMs does not make requests time out immediately", async () => {
  const ok =
    (() =>
      new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response("", { status: 200 })), 50)
      )) as typeof fetch;
  for (const timeoutMs of [Number.NaN, 2 ** 40]) {
    const client = BlobClient.fromAuth(SHARED_KEY_AUTH, ok, timeoutMs);
    const resp = await client.request({ method: "GET", path: "/c/b" });
    assertEquals(resp.status, 200);
  }
});
