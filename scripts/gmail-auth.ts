/**
 * One-time Gmail consent. Opens a local callback server, prints the Google consent URL, and on
 * approval writes GMAIL_REFRESH_TOKEN into .env.local. Run: `npm run gmail:auth`.
 * Prerequisites (OAuth client, test user): docs/architecture/1-intake.md#gmail-setup
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { GMAIL_REDIRECT_URI, GMAIL_SCOPES, createOAuthClient } from "../src/server/features/intake/gmail/client";

const ENV_FILE = ".env.local";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function upsertEnv(key: string, value: string) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  while (lines.at(-1) === "") lines.pop();
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");
}

const oauth = createOAuthClient();
const state = randomBytes(16).toString("hex"); // CSRF: the callback must echo it back
const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES, state });
const { port, pathname } = new URL(GMAIL_REDIRECT_URI);

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", GMAIL_REDIRECT_URI);
  if (reqUrl.pathname !== pathname) { res.writeHead(404).end(); return; }
  try {
    if (reqUrl.searchParams.get("state") !== state) throw new Error("state mismatch — restart gmail:auth");
    const error = reqUrl.searchParams.get("error");
    if (error) throw new Error(`Google returned: ${error}`);
    const code = reqUrl.searchParams.get("code");
    if (!code) throw new Error("no ?code in callback");
    const { tokens } = await oauth.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error("no refresh token returned — remove the app at https://myaccount.google.com/permissions and retry");
    }
    upsertEnv("GMAIL_REFRESH_TOKEN", tokens.refresh_token);
    res.writeHead(200, { "content-type": "text/plain" }).end("Gmail connected. You can close this tab.");
    console.log(`\n✔ Refresh token saved to ${ENV_FILE}. Next: npm run gmail:poll`);
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" }).end(String(err));
    console.error(`\n✘ ${String(err)}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(port), "127.0.0.1", () => {
  console.log("Open this URL in your browser and approve read-only Gmail access:\n");
  console.log(url);
  console.log(`\nWaiting for Google to redirect to ${GMAIL_REDIRECT_URI} …`);
});
