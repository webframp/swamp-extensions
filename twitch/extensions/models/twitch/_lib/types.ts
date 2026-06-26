// Twitch API shared types
// SPDX-License-Identifier: Apache-2.0

/** Credentials needed for all Helix API calls */
export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
}

/** Standard Twitch Helix paginated response envelope */
export interface HelixResponse<T> {
  data: T[];
  pagination?: { cursor?: string };
  total?: number;
}

/** Twitch OAuth2 token response */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}
