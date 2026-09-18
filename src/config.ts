import { homedir } from "node:os";
import { resolve } from "node:path";

export const CODEX_AUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_ISSUER = "https://auth.openai.com";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_CONTEXT_SUMMARY_INTERVAL = 8;
export const workspaceRoot = resolve(process.cwd());

export function authFilePath(): string {
  return process.env.JEV_AUTH_FILE ?? resolve(homedir(), ".jev", "auth.json");
}

export function codexModel(): string {
  return process.env.JEV_CODEX_MODEL ?? process.env.JEV_MODEL ?? DEFAULT_CODEX_MODEL;
}

export function jevModel(): string {
  return process.env.JEV_JEV_MODEL ?? DEFAULT_JEV_MODEL;
}

export function contextSummaryInterval(): number {
  const value = Number(
    process.env.JEV_CONTEXT_SUMMARY_INTERVAL ?? DEFAULT_CONTEXT_SUMMARY_INTERVAL,
  );
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CONTEXT_SUMMARY_INTERVAL;
}
