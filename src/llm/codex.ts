import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import { createCodexClient } from "../auth/codex-oauth.ts";
import { codexModel } from "../config.ts";
import type { AgentAction, AgentContext, CodexToolCall } from "../types.ts";

const fileTools: FunctionTool[] = [
  {
    type: "function",
    name: "run_command",
    description: "Run one bash command in the workspace.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run." },
        reason: { type: "string", description: "Why this command is needed." },
      },
      required: ["command", "reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write complete UTF-8 text to a file inside the workspace.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Complete file content." },
        reason: { type: "string", description: "Why this file should change." },
      },
      required: ["path", "content", "reason"],
      additionalProperties: false,
    },
  },
];

const instructions = `You are the execution model for jev, a careful coding agent.
The TypeSafe Jev router has already selected the action for this turn.
Use workspace-relative paths only. Do not reveal hidden chain-of-thought.
For think, give a concise useful reasoning summary. For tool actions, call exactly the requested tool.
Never claim that a tool ran or a file changed; the host will execute and report its result.`;

const summaryInstructions = `You are the final session summarizer for a coding agent.
Jev has selected finish, so summarize the completed session for the user in Japanese.
Include: the original goal, the actions taken, files changed or inspected, command/test results, and any remaining issue.
Be concise and factual. Do not invent work that is not present in the session history.
Do not reveal hidden chain-of-thought; summarize observable decisions and results only.`;

const contextSummaryInstructions = `You maintain the working memory for a coding agent.
Summarize the complete session history into a compact Japanese context for the next Jev decision.
Preserve the task goal, inspected file paths and important contents, commands and results, file changes, unresolved problems, and the latest state.
Merge the prior summary with new history. Be factual and concise. Do not reveal hidden chain-of-thought.`;

const adviceInstructions = `You are a coding-agent recovery advisor.
The agent appears to be repeating exactly the same operation.
Using the task, working summary, and recent history, give one concise actionable recommendation in Japanese to make progress.
Point out what should change in the next attempt. Do not execute tools and do not reveal hidden chain-of-thought.`;

function contextPrompt(context: AgentContext, action: AgentAction): string {
  return JSON.stringify(
    {
      action,
      task: context.task,
      workspace: context.workspace,
      session_summary: context.sessionSummary || null,
      recent_history: context.history.slice(-8),
    },
    null,
    2,
  );
}

function selectedTool(action: AgentAction): FunctionTool | undefined {
  if (action === "inspect" || action === "think" || action === "finish") return undefined;
  return fileTools.find((tool) => tool.name === action);
}

function getFunctionCall(output: ResponseOutputItem[]): ResponseFunctionToolCall | undefined {
  return output.find((item): item is ResponseFunctionToolCall => item.type === "function_call");
}

type CodexStreamParams = Omit<ResponseCreateParamsBase, "stream"> & {
  stream?: true;
};

type CodexStreamResult = {
  output: ResponseOutputItem[];
  output_text: string;
};

async function completeStream(
  client: OpenAI,
  params: CodexStreamParams,
): Promise<CodexStreamResult> {
  const stream = client.responses.stream(params);
  const output: ResponseOutputItem[] = [];
  let outputText = "";

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      outputText += event.delta;
    } else if (event.type === "response.output_item.done") {
      output.push(event.item);
    } else if (event.type === "error") {
      throw new Error(`Codex stream error: ${event.message}`);
    } else if (event.type === "response.failed") {
      throw new Error(`Codex response failed: ${event.response.error?.message ?? "unknown error"}`);
    }
  }

  if (!outputText) outputText = textFromOutputItems(output);
  return { output, output_text: outputText };
}

function textFromOutputItems(output: ResponseOutputItem[]): string {
  return output
    .flatMap((item) =>
      item.type === "message"
        ? item.content.flatMap((content) => (content.type === "output_text" ? [content.text] : []))
        : [],
    )
    .join("");
}

export type CodexResult =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: CodexToolCall };

export class CodexModel {
  private readonly model: string;
  private clientPromise: Promise<OpenAI> | undefined;

  constructor(model = codexModel()) {
    this.model = model;
  }

  async execute(action: AgentAction, context: AgentContext): Promise<CodexResult> {
    this.clientPromise ??= createCodexClient();
    const client = await this.clientPromise;
    const tool = selectedTool(action);
    const params: CodexStreamParams = {
      model: this.model,
      instructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Perform the selected action and return only what the host needs:\n${contextPrompt(context, action)}`,
            },
          ],
        },
      ],
      reasoning: { effort: "high" },
      store: false,
      stream: true,
    };

    if (tool) {
      params.tools = [tool];
      params.tool_choice = { type: "function", name: tool.name };
    }

    const response = await completeStream(client, params);
    const call = tool ? getFunctionCall(response.output) : undefined;
    if (call) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        throw new Error(`Codex returned invalid JSON arguments for ${call.name}`);
      }
      return {
        type: "tool_call",
        call: { name: call.name as CodexToolCall["name"], arguments: args },
      };
    }

    return { type: "text", text: response.output_text.trim() };
  }

  async summarizeContext(context: AgentContext): Promise<string> {
    return this.requestText(
      contextSummaryInstructions,
      JSON.stringify(
        {
          task: context.task,
          workspace: context.workspace,
          prior_summary: context.sessionSummary || null,
          session_history: context.history,
        },
        null,
        2,
      ),
    );
  }

  async advise(context: AgentContext, repeatedBehavior: string): Promise<string> {
    return this.requestText(
      adviceInstructions,
      JSON.stringify(
        {
          task: context.task,
          workspace: context.workspace,
          session_summary: context.sessionSummary || null,
          recent_history: context.history.slice(-8),
          repeated_behavior: repeatedBehavior,
        },
        null,
        2,
      ),
    );
  }

  async summarize(context: AgentContext): Promise<string> {
    const text = await this.requestText(
      summaryInstructions,
      JSON.stringify(
        {
          task: context.task,
          workspace: context.workspace,
          session_summary: context.sessionSummary || null,
          session_history: context.history,
        },
        null,
        2,
      ),
    );
    return text || "セッションを完了しました。";
  }

  private async requestText(instructionsText: string, inputText: string): Promise<string> {
    this.clientPromise ??= createCodexClient();
    const client = await this.clientPromise;
    const response = await completeStream(client, {
      model: this.model,
      instructions: instructionsText,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: inputText,
            },
          ],
        },
      ],
      reasoning: { effort: "high" },
      store: false,
      stream: true,
    });

    return response.output_text.trim();
  }
}
