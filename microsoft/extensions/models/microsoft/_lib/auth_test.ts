// Tests for _lib/auth.ts
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  initiateDeviceCode,
  MicrosoftAuthError,
  pollDeviceCode,
  refreshAccessToken,
} from "./auth.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "at-test-token",
    refresh_token: "rt-new-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "Mail.ReadWrite offline_access",
    ...overrides,
  };
}

/** Build a mock fetch that returns a pre-defined response for any URL. */
function mockFetch(
  status: number,
  body: Record<string, unknown>,
): typeof fetch {
  return (_input, _init) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

Deno.test("refreshAccessToken: returns token on success", async () => {
  const tokenBody = makeTokenResponse();
  const fetchFn = mockFetch(200, tokenBody);

  const result = await refreshAccessToken(
    {
      tenantId: "tenant-123",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      refreshToken: "rt-old",
    },
    fetchFn,
  );

  assertEquals(result.access_token, "at-test-token");
  assertEquals(result.refresh_token, "rt-new-refresh");
});

Deno.test(
  "refreshAccessToken: throws MicrosoftAuthError(invalid_grant) on expired token",
  async () => {
    const fetchFn = mockFetch(400, {
      error: "invalid_grant",
      error_description: "AADSTS70008: The refresh token has expired.",
    });

    const err = await assertRejects(
      () =>
        refreshAccessToken(
          {
            tenantId: "tenant-123",
            clientId: "client-abc",
            clientSecret: "secret-xyz",
            refreshToken: "rt-expired",
          },
          fetchFn,
        ),
      MicrosoftAuthError,
    );

    assertEquals(err.code, "invalid_grant");
  },
);

Deno.test(
  "refreshAccessToken: throws MicrosoftAuthError on other token errors",
  async () => {
    const fetchFn = mockFetch(400, {
      error: "invalid_client",
      error_description: "Invalid client credentials",
    });

    const err = await assertRejects(
      () =>
        refreshAccessToken(
          {
            tenantId: "tenant-123",
            clientId: "bad-client",
            clientSecret: "bad-secret",
            refreshToken: "rt-old",
          },
          fetchFn,
        ),
      MicrosoftAuthError,
    );

    assertEquals(err.code, "invalid_client");
  },
);

// ---------------------------------------------------------------------------
// initiateDeviceCode
// ---------------------------------------------------------------------------

Deno.test("initiateDeviceCode: returns device code response on success", async () => {
  const deviceBody = {
    device_code: "dc-abc123",
    user_code: "ABCD-1234",
    verification_uri: "https://microsoft.com/devicelogin",
    expires_in: 900,
    interval: 5,
    message: "Go to https://microsoft.com/devicelogin and enter ABCD-1234",
  };

  const fetchFn = mockFetch(200, deviceBody);
  const result = await initiateDeviceCode("tenant-123", "client-abc", fetchFn);

  assertEquals(result.user_code, "ABCD-1234");
  assertEquals(result.device_code, "dc-abc123");
  assertEquals(result.interval, 5);
});

Deno.test("initiateDeviceCode: throws on error response", async () => {
  const fetchFn = mockFetch(400, {
    error: "invalid_client",
    error_description: "Unknown client",
  });

  const err = await assertRejects(
    () => initiateDeviceCode("tenant-123", "bad-client", fetchFn),
    MicrosoftAuthError,
  );

  assertEquals(err.code, "invalid_client");
});

// ---------------------------------------------------------------------------
// pollDeviceCode
// ---------------------------------------------------------------------------

Deno.test(
  "pollDeviceCode: returns token when authorization_pending then success",
  async () => {
    let callCount = 0;
    const tokenBody = makeTokenResponse();

    const fetchFn: typeof fetch = (_input, _init) => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "authorization_pending" }),
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(tokenBody), { status: 200 }),
      );
    };

    const noopSleep = () => Promise.resolve();

    const result = await pollDeviceCode(
      "tenant-123",
      "client-abc",
      "secret-xyz",
      "dc-abc",
      5,
      30_000,
      fetchFn,
      noopSleep,
    );

    assertEquals(result.access_token, "at-test-token");
    assertEquals(callCount, 3);
  },
);

Deno.test("pollDeviceCode: increases interval on slow_down", async () => {
  let callCount = 0;
  const intervals: number[] = [];
  const tokenBody = makeTokenResponse();

  const fetchFn: typeof fetch = (_input, _init) => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(tokenBody), { status: 200 }),
    );
  };

  const sleepFn = (ms: number) => {
    intervals.push(ms);
    return Promise.resolve();
  };

  await pollDeviceCode(
    "tenant-123",
    "client-abc",
    "secret-xyz",
    "dc-abc",
    5,
    30_000,
    fetchFn,
    sleepFn,
  );

  // First poll uses 5s, second poll uses 10s (5+5 slow_down penalty)
  assertEquals(intervals[0], 5000);
  assertEquals(intervals[1], 10_000);
});

Deno.test("pollDeviceCode: throws on terminal error", async () => {
  const fetchFn = mockFetch(400, {
    error: "access_denied",
    error_description: "User denied access",
  });

  const err = await assertRejects(
    () =>
      pollDeviceCode(
        "tenant-123",
        "client-abc",
        "secret-xyz",
        "dc-abc",
        5,
        30_000,
        fetchFn,
        () => Promise.resolve(),
      ),
    MicrosoftAuthError,
  );

  assertEquals(err.code, "access_denied");
});

Deno.test("pollDeviceCode: throws device_code_expired when deadline passes", async () => {
  const fetchFn = mockFetch(400, { error: "authorization_pending" });

  const err = await assertRejects(
    () =>
      pollDeviceCode(
        "tenant-123",
        "client-abc",
        "secret-xyz",
        "dc-abc",
        5,
        0, // immediate timeout
        fetchFn,
        () => Promise.resolve(),
      ),
    MicrosoftAuthError,
  );

  assertEquals(err.code, "device_code_expired");
});
