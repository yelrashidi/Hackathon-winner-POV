import { auth, gmail, type gmail_v1 } from "@googleapis/gmail";

/**
 * Gmail connection. One read-only scope: intake never sends, deletes or relabels mail, so a
 * leaked token can read but not act. Credentials come from env (.env.local, never committed):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET   — Google Cloud OAuth client of type "Desktop app"
 *   GMAIL_REFRESH_TOKEN                    — written by `npm run gmail:auth`
 * Setup steps: docs/architecture/1-intake.md#gmail-setup
 */
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
export const GMAIL_REDIRECT_URI = "http://127.0.0.1:53682/oauth2callback";

export type GmailClient = gmail_v1.Gmail;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Add it to .env.local (see docs/architecture/1-intake.md#gmail-setup).`);
  }
  return value;
}

export function createOAuthClient() {
  return new auth.OAuth2(requireEnv("GMAIL_CLIENT_ID"), requireEnv("GMAIL_CLIENT_SECRET"), GMAIL_REDIRECT_URI);
}

/** Authenticated Gmail client; the library refreshes the access token from the refresh token. */
export function createGmailClient(): GmailClient {
  const oauth = createOAuthClient();
  oauth.setCredentials({ refresh_token: requireEnv("GMAIL_REFRESH_TOKEN") });
  return gmail({ version: "v1", auth: oauth });
}
