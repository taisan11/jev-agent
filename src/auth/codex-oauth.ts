import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import OpenAI from "openai";
import {
  CODEX_AUTH_CLIENT_ID,
  CODEX_AUTH_ISSUER,
  CODEX_RESPONSES_URL,
  authFilePath,
} from "../config.ts";

export type CodexAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
};

type JwtClaims = {
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  organizations?: Array<{ id: string }>;
};

function randomBase64Url(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return Buffer.from(value).toString("base64url");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

function decodeJwtClaims(token: string): JwtClaims {
  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return {};
  }
}

function getAccountId(...tokens: string[]): string | undefined {
  for (const token of tokens) {
    const claims = decodeJwtClaims(token);
    const accountId =
      claims.chatgpt_account_id ??
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id;
    if (accountId) return accountId;
  }
  return undefined;
}

async function saveAuth(auth: CodexAuth): Promise<void> {
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(auth, null, 2)}\n`);
  try {
    await chmod(path, 0o600);
  } catch {
    // Best effort on platforms that do not support chmod.
  }
}

async function loadAuth(): Promise<CodexAuth | undefined> {
  const file = Bun.file(authFilePath());
  if (!(await file.exists())) return undefined;

  try {
    const auth = JSON.parse(await file.text()) as Partial<CodexAuth>;
    if (
      typeof auth.accessToken !== "string" ||
      typeof auth.refreshToken !== "string" ||
      typeof auth.expiresAt !== "number" ||
      typeof auth.accountId !== "string"
    ) {
      throw new Error("invalid auth file");
    }
    return auth as CodexAuth;
  } catch (error) {
    throw new Error(`認証ファイルを読み込めません: ${authFilePath()} (${String(error)})`);
  }
}

async function exchangeToken(body: URLSearchParams): Promise<CodexAuth> {
  const response = await fetch(`${CODEX_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }

  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!token.access_token || !token.refresh_token) {
    throw new Error("OAuth response did not contain access_token and refresh_token");
  }

  const accountId = getAccountId(token.access_token, token.id_token ?? "");
  if (!accountId) throw new Error("ChatGPT account ID could not be found in OAuth token");

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId,
  };
}

export async function login(): Promise<void> {
  const verifier = randomBase64Url();
  const state = randomBase64Url(24);
  const challenge = await sha256Base64Url(verifier);
  let resolveLogin!: () => void;
  let rejectLogin!: (reason?: unknown) => void;
  const loginComplete = new Promise<void>((resolvePromise, reject) => {
    resolveLogin = resolvePromise;
    rejectLogin = reject;
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let port: number | undefined;

  for (const candidate of [1455, 1457]) {
    try {
      server = Bun.serve({
        port: candidate,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/auth/callback") {
            return new Response("jev OAuth callback is ready.");
          }

          const code = url.searchParams.get("code");
          if (url.searchParams.get("state") !== state || !code) {
            rejectLogin(new Error("OAuth state or authorization code is invalid"));
            return new Response("Invalid OAuth callback. You can close this tab.", { status: 400 });
          }

          void completeLogin(code, verifier, port!).then(resolveLogin, rejectLogin);
          return new Response("jev login succeeded. You can close this tab.");
        },
      });
      port = candidate;
      break;
    } catch {
      server?.stop(true);
      server = undefined;
    }
  }

  if (!server || !port) throw new Error("OAuth callback port 1455/1457 is unavailable");

  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authorization = new URL(`${CODEX_AUTH_ISSUER}/oauth/authorize`);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_AUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "jev-agent",
  }).toString();

  console.log(`ブラウザでログインしてください:\n${authorization.href}\n`);
  if (!process.env.JEV_NO_BROWSER) {
    Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", authorization.href], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  console.log(`コールバックを待っています (localhost:${port})...`);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("OAuth login timed out after 5 minutes")),
      300_000,
    );
  });
  await Promise.race([loginComplete, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
    server?.stop(true);
  });
}

async function completeLogin(code: string, verifier: string, port: number): Promise<void> {
  const auth = await exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `http://localhost:${port}/auth/callback`,
      client_id: CODEX_AUTH_CLIENT_ID,
      code_verifier: verifier,
    }),
  );
  await saveAuth(auth);
  console.log(`\nログインしました。認証情報を ${authFilePath()} に保存しました。`);
}

async function refreshAuth(auth: CodexAuth): Promise<CodexAuth> {
  const response = await fetch(`${CODEX_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      client_id: CODEX_AUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status}). Run: bun run index.ts login`);
  }

  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!token.access_token) throw new Error("OAuth refresh response did not contain access_token");

  const refreshed: CodexAuth = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? auth.refreshToken,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountId: getAccountId(token.access_token, token.id_token ?? "") ?? auth.accountId,
  };
  await saveAuth(refreshed);
  return refreshed;
}

async function validAuth(): Promise<CodexAuth> {
  const auth = await loadAuth();
  if (!auth) throw new Error("未ログインです。先に `bun run index.ts login` を実行してください。");
  return auth.expiresAt > Date.now() + 120_000 ? auth : refreshAuth(auth);
}

export async function createCodexClient(): Promise<OpenAI> {
  const auth = await validAuth();
  return new OpenAI({
    apiKey: auth.accessToken,
    baseURL: CODEX_RESPONSES_URL,
    defaultHeaders: {
      "ChatGPT-Account-Id": auth.accountId,
      originator: "jev-agent",
    },
    maxRetries: 2,
    timeout: 10 * 60 * 1000,
  });
}

export async function logout(): Promise<void> {
  try {
    await unlink(authFilePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
