import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { workspaceRoot } from "../config.ts";
import type { ApprovalRequest, CodexToolCall } from "../types.ts";

const MAX_OUTPUT = 12_000;
const MAX_FILE = 80_000;
const MAX_INSPECT_CONTENT = 8_000;

const ignoredDirectories = new Set([".git", ".jev", "node_modules", ".cache", "dist", "build"]);

const textExtensions = new Set([
  ".cjs",
  ".css",
  ".d.ts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export type WorkspaceApproval = (request: ApprovalRequest) => Promise<boolean>;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function insideWorkspace(path: string): string {
  const absolute = resolve(workspaceRoot, path);
  const outside = relative(workspaceRoot, absolute);
  if (outside === ".." || outside.startsWith(`..${"/"}`) || isAbsolute(outside)) {
    throw new Error(`workspace外のパスは操作できません: ${path}`);
  }
  return absolute;
}

type WorkspaceEntry = {
  kind: "directory" | "file" | "symlink";
  path: string;
  absolute: string;
};

/** Walk from the workspace root and read safe text files without asking Codex for paths. */
export async function inspectWorkspace(): Promise<string> {
  const entries = await walkWorkspace(workspaceRoot, "");
  const filePaths = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  const lines = ["workspace: .", "", "file paths:", ...filePaths, "", "directory tree:"];
  for (const entry of entries) {
    const indent = "  ".repeat(entry.path.split("/").length - 1);
    const marker = entry.kind === "directory" ? "📁" : entry.kind === "symlink" ? "🔗" : "📄";
    lines.push(`${indent}${marker} ${entry.path}`);
  }

  lines.push("", "readable files:");
  let remaining = MAX_INSPECT_CONTENT;
  for (const entry of entries) {
    if (entry.kind !== "file" || remaining <= 0 || isSensitivePath(entry.path)) continue;
    if (!isTextFile(entry.path)) continue;

    try {
      const content = await readFile(entry.absolute, "utf8");
      const snippet = truncate(content, Math.min(MAX_FILE, remaining));
      lines.push(`\n--- ${entry.path} ---\n${snippet}`);
      remaining -= snippet.length;
    } catch {
      lines.push(`\n--- ${entry.path} ---\n[read failed]`);
    }
  }

  lines.push("\n[sensitive files and generated directories are omitted]");
  return truncate(lines.join("\n"), MAX_OUTPUT);
}

async function walkWorkspace(root: string, prefix: string): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  const directory = prefix ? resolve(root, prefix) : root;
  const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const child of children) {
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    const absolute = resolve(root, path);
    if (child.isDirectory()) {
      if (ignoredDirectories.has(child.name) || isSensitivePath(path)) continue;
      entries.push({ kind: "directory", path: `${path}/`, absolute });
      entries.push(...(await walkWorkspace(root, path)));
    } else if (child.isSymbolicLink()) {
      entries.push({ kind: "symlink", path, absolute });
    } else if (child.isFile() && !isSensitivePath(path)) {
      entries.push({ kind: "file", path, absolute });
    }
  }
  return entries;
}

function isSensitivePath(path: string): boolean {
  const name = basename(path);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "auth.json" ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name.endsWith(".token")
  );
}

function isTextFile(path: string): boolean {
  const name = basename(path);
  if (name === "Dockerfile" || name === "Makefile" || name === "Procfile") return true;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && textExtensions.has(name.slice(dot));
}

async function runCommand(
  command: string,
  reason: string,
  approve: WorkspaceApproval,
): Promise<string> {
  const approved = await approve({ action: "run_command", summary: command, detail: reason });
  if (!approved) {
    return JSON.stringify({
      ok: false,
      denied: true,
      error: "ユーザーがコマンド実行を拒否しました",
    });
  }

  const child = Bun.spawn(["bash", "-lc", command], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 120_000);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  return JSON.stringify({
    ok: exitCode === 0,
    exitCode,
    stdout: truncate(stdout, MAX_OUTPUT),
    stderr: truncate(stderr, MAX_OUTPUT),
  });
}

async function writeWorkspaceFile(path: string, content: string): Promise<string> {
  const absolute = insideWorkspace(path);
  await mkdir(dirname(absolute), { recursive: true });
  await Bun.write(absolute, content);
  return JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content, "utf8") });
}

export async function executeWorkspaceTool(
  call: CodexToolCall,
  approve: WorkspaceApproval,
): Promise<string> {
  if (call.name === "run_command") {
    return runCommand(
      String(call.arguments.command ?? ""),
      String(call.arguments.reason ?? ""),
      approve,
    );
  }
  return writeWorkspaceFile(
    String(call.arguments.path ?? ""),
    String(call.arguments.content ?? ""),
  );
}
