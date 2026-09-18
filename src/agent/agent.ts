import { contextSummaryInterval, workspaceRoot } from "../config.ts";
import { CodexModel } from "../llm/codex.ts";
import { JevRouter } from "../jev/router.ts";
import { executeWorkspaceTool, inspectWorkspace } from "../tools/workspace.ts";
import type { AgentCallbacks, AgentContext } from "../types.ts";

function shorten(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n...[truncated]`;
}

export class JevAgent {
  private readonly router: JevRouter;
  private readonly codex: CodexModel;

  constructor() {
    this.router = new JevRouter();
    this.codex = new CodexModel();
  }

  async run(task: string, callbacks: AgentCallbacks): Promise<void> {
    const context: AgentContext = {
      task,
      workspace: workspaceRoot,
      history: [],
      sessionSummary: "",
    };
    callbacks.onEvent({ kind: "user", text: task });

    let step = 1;
    let completedActions = 0;
    let previousBehavior: string | undefined;
    let repeatedBehaviorCount = 0;
    while (true) {
      callbacks.onEvent({
        kind: "status",
        text: `Jevが次のアクションを判断中 (${step})`,
      });
      const decision = await this.router.choose(context);
      callbacks.onEvent({
        kind: "decision",
        text: `Jev → ${decision.action} (confidence ${(decision.confidence * 100).toFixed(0)}%)`,
      });
      context.history.push(
        `jev decision: ${decision.action} (confidence ${decision.confidence.toFixed(2)})`,
      );

      if (decision.action === "finish") {
        callbacks.onEvent({
          kind: "status",
          text: "Jevがfinishを選択。セッションを要約中",
        });
        const summary = await this.codex.summarize(context);
        callbacks.onEvent({ kind: "assistant", text: summary });
        context.history.push(`session summary: ${summary}`);
        return;
      }

      if (decision.action === "inspect") {
        callbacks.onEvent({
          kind: "tool",
          text: "LOCAL INSPECT: workspace rootからディレクトリを再帰的に読み取り",
        });
        const inspection = await inspectWorkspace();
        callbacks.onEvent({ kind: "result", text: inspection });
        context.history.push(`inspect (local recursive read):\n${shorten(inspection)}`);
        await this.afterAction(
          context,
          callbacks,
          "inspect:workspace-recursive-read",
          completedActions + 1,
          {
            previousBehavior,
            repeatedBehaviorCount,
            setPreviousBehavior: (value) => {
              previousBehavior = value;
            },
            setRepeatedBehaviorCount: (value) => {
              repeatedBehaviorCount = value;
            },
          },
        );
        completedActions += 1;
        step += 1;
        continue;
      }

      const result = await this.codex.execute(decision.action, context);
      if (result.type === "text") {
        callbacks.onEvent({ kind: "thought", text: result.text });
        context.history.push(`${decision.action}: ${result.text}`);
        await this.afterAction(
          context,
          callbacks,
          `${decision.action}:${result.text}`,
          completedActions + 1,
          {
            previousBehavior,
            repeatedBehaviorCount,
            setPreviousBehavior: (value) => {
              previousBehavior = value;
            },
            setRepeatedBehaviorCount: (value) => {
              repeatedBehaviorCount = value;
            },
          },
        );
        completedActions += 1;
        step += 1;
        continue;
      }

      const call = result.call;
      const detail = formatToolCall(call);
      callbacks.onEvent({ kind: "tool", text: `${call.name}: ${detail}` });
      const toolResult = await executeWorkspaceTool(call, callbacks.approve);
      callbacks.onEvent({ kind: "result", text: formatToolResult(toolResult) });
      context.history.push(`${call.name}: ${detail}\nresult: ${shorten(toolResult)}`);
      await this.afterAction(
        context,
        callbacks,
        `${call.name}:${JSON.stringify(call.arguments)}`,
        completedActions + 1,
        {
          previousBehavior,
          repeatedBehaviorCount,
          setPreviousBehavior: (value) => {
            previousBehavior = value;
          },
          setRepeatedBehaviorCount: (value) => {
            repeatedBehaviorCount = value;
          },
        },
      );
      completedActions += 1;
      step += 1;
    }
  }

  private async afterAction(
    context: AgentContext,
    callbacks: AgentCallbacks,
    behavior: string,
    actionNumber: number,
    repeat: {
      previousBehavior: string | undefined;
      repeatedBehaviorCount: number;
      setPreviousBehavior: (value: string | undefined) => void;
      setRepeatedBehaviorCount: (value: number) => void;
    },
  ): Promise<void> {
    const sameAsPrevious = repeat.previousBehavior === behavior;
    const nextRepeatCount = sameAsPrevious ? repeat.repeatedBehaviorCount + 1 : 1;
    repeat.setPreviousBehavior(behavior);
    repeat.setRepeatedBehaviorCount(nextRepeatCount);

    if (sameAsPrevious && nextRepeatCount >= 2) {
      callbacks.onEvent({
        kind: "status",
        text: "同じ操作が続いたためCodexに改善案を相談中",
      });
      const advice = await this.codex.advise(context, behavior);
      callbacks.onEvent({ kind: "thought", text: `Codex advice:\n${advice}` });
      context.history.push(`codex recovery advice: ${advice}`);
      repeat.setPreviousBehavior(undefined);
      repeat.setRepeatedBehaviorCount(0);
    }

    const interval = contextSummaryInterval();
    if (actionNumber % interval !== 0) return;

    callbacks.onEvent({
      kind: "status",
      text: `セッション履歴を要約中 (${actionNumber}アクション)`,
    });
    const summary = await this.codex.summarizeContext(context);
    context.sessionSummary = summary;
    context.history = context.history.slice(-8);
    callbacks.onEvent({ kind: "thought", text: `Context summary:\n${summary}` });
  }
}

function formatToolCall(call: { name: string; arguments: Record<string, unknown> }): string {
  if (call.name === "run_command") return String(call.arguments.command ?? "");
  if (call.name === "write_file") return String(call.arguments.path ?? "");
  return String(call.arguments.path ?? "");
}

function formatToolResult(value: string): string {
  try {
    const result = JSON.parse(value) as {
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
    };
    if (result.stdout || result.stderr) {
      return `ok=${String(result.ok)}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`;
    }
    return JSON.stringify(result);
  } catch {
    return value;
  }
}
