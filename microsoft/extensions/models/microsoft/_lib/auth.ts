// Microsoft Graph Authentication Helper
// Implements delegated OAuth2 with device code flow and silent token refresh.
// SPDX-License-Identifier: AGPL-3.0-or-later WITH Swamp-Extension-Exception

const TOKEN_ENDPOINT_BASE = "https://login.microsoftonline.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicrosoftCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

// The scopes required for Outlook and Teams delegated access.
//
// Intentionally minimal — scoped to the signed-in user's own data only:
//   - Mail.Send is excluded (extension never sends mail)
//   - Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All are
//     excluded because "All" variants cover the entire tenant and
//     ChannelMessage.Read.All additionally requires admin consent.
//     list_channel_messages and list_teams will return 403 unless those scopes
//     are separately granted; Chat.Read is sufficient for 1:1 and group chats.
export const GRAPH_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "MailboxSettings.Read",
  "Chat.Read",
].join(" ");

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a new access token.
 * Throws MicrosoftAuthError with code "invalid_grant" when the refresh token
 * has expired (90-day inactivity or password change) — callers should direct
 * the user to re-run `bootstrap`.
 */
export async function refreshAccessToken(
  creds: MicrosoftCredentials,
  fetchFn: typeof fetch = fetch,
): Promise<TokenResponse> {
  const url = `${TOKEN_ENDPOINT_BASE}/${creds.tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    scope: GRAPH_SCOPES,
  });

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok || data["error"]) {
    const errorCode = String(data["error"] ?? "unknown");
    const errorDesc = String(
      data["error_description"] ?? "Token refresh failed",
    );

    if (errorCode === "invalid_grant") {
      throw new MicrosoftAuthError(
        "invalid_grant",
        "Refresh token has expired or been revoked. " +
          "Re-run the `bootstrap` method to re-authenticate via device code flow.",
      );
    }

    throw new MicrosoftAuthError(errorCode, errorDesc);
  }

  return data as unknown as TokenResponse;
}

// ---------------------------------------------------------------------------
// Device code flow
// ---------------------------------------------------------------------------

/**
 * Initiate a device code flow and return the DeviceCodeResponse.
 * The caller should display `response.message` to the user, then poll
 * `pollDeviceCode()` until a token is returned.
 */
export async function initiateDeviceCode(
  tenantId: string,
  clientId: string,
  fetchFn: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const url = `${TOKEN_ENDPOINT_BASE}/${tenantId}/oauth2/v2.0/devicecode`;

  const body = new URLSearchParams({
    client_id: clientId,
    scope: GRAPH_SCOPES,
  });

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const data = await response.json() as Record<string, unknown>;
    throw new MicrosoftAuthError(
      String(data["error"] ?? "device_code_error"),
      String(
        data["error_description"] ?? "Failed to initiate device code flow",
      ),
    );
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

/**
 * Poll the token endpoint until the user completes device code authentication.
 * Returns the token once granted, or throws on permanent failure.
 */
export async function pollDeviceCode(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  intervalSeconds: number,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<TokenResponse> {
  const url = `${TOKEN_ENDPOINT_BASE}/${tenantId}/oauth2/v2.0/token`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleepFn(intervalSeconds * 1000);

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth2:grant-type:device_code",
      client_id: clientId,
      client_secret: clientSecret,
      device_code: deviceCode,
    });

    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = await response.json() as Record<string, unknown>;

    if (response.ok && data["access_token"]) {
      return data as unknown as TokenResponse;
    }

    const errorCode = String(data["error"] ?? "");

    if (errorCode === "authorization_pending") {
      // Normal — keep polling.
      continue;
    }

    if (errorCode === "slow_down") {
      // Server requests a slower poll interval.
      intervalSeconds += 5;
      continue;
    }

    // Any other error is terminal.
    throw new MicrosoftAuthError(
      errorCode,
      String(
        data["error_description"] ??
          "Device code authentication failed",
      ),
    );
  }

  throw new MicrosoftAuthError(
    "device_code_expired",
    "Device code authentication timed out. Re-run `bootstrap` to try again.",
  );
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class MicrosoftAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}
