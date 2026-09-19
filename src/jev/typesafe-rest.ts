import type { AgentAction, AgentContext } from "../types.ts";

const defaultBaseUrl = "https://api.typesafe.ai";

const actionCriteria: Record<AgentAction, string> = {
  inspect:
    "Walk down from the workspace root and locally read relevant text files.",
  think: "Reason about the task and decide the next implementation step.",
  run_command: "Run a command to inspect, test, build, or modify the workspace.",
  write_file: "Create or update a workspace file with a complete implementation.",
  finish: "The task is complete, or a final concise response is appropriate.",
};

type ChoiceAnswer = {
  choice: unknown;
  confidence: unknown;
  probabilities: unknown;
};

export type JevRestDecision = {
  action: AgentAction;
  confidence: number;
  probabilities: Readonly<Record<string, number>>;
};

export async function requestJevDecision(
  context: AgentContext,
  model: string,
): Promise<JevRestDecision> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TYPESAFE_API_KEY is not set. Set it before starting jev-agent.");
  }

  const baseUrl = (process.env.TYPESAFE_BASE_URL ?? defaultBaseUrl).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/systemone`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // The current API rejects requests that do not explicitly enable streaming.
      stream: true,
      state: {
        task: context.task,
        workspace: context.workspace,
        session_summary: context.sessionSummary || null,
        recent_history: context.history.slice(-8),
      },
      questions: {
        next_action: {
          type: "choice",
          instructions:
            "Which single action should the agent take next to make progress on the task?",
          criteria: actionCriteria,
        },
      },
    }),
  });

  const rawBody = await response.text();
  const body = parseResponseBody(rawBody, response.headers.get("content-type"));
  if (!response.ok) {
    throw new Error(`TypeSafe REST API ${response.status}: ${describeError(body)}`);
  }

  return parseDecision(body);
}

function parseResponseBody(rawBody: string, contentType: string | null): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    if (contentType?.includes("text/event-stream") || rawBody.includes("data:")) {
      return parseEventStream(rawBody);
    }
    return rawBody;
  }
}

function parseEventStream(rawBody: string): unknown {
  let latest: unknown;
  for (const line of rawBody.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed) && "answers" in parsed) latest = parsed;
      if (isRecord(parsed) && isRecord(parsed.data) && "answers" in parsed.data) {
        latest = parsed.data;
      }
    } catch {
      // Ignore non-JSON event metadata; the final event contains the result.
    }
  }
  return latest ?? rawBody;
}

function parseDecision(value: unknown): JevRestDecision {
  if (!isRecord(value) || !isRecord(value.answers) || !isRecord(value.answers.next_action)) {
    throw new Error("TypeSafe REST API returned no next_action answer.");
  }

  const answer = value.answers.next_action as ChoiceAnswer;
  if (!isAgentAction(answer.choice)) {
    throw new Error(`TypeSafe REST API returned an unknown action: ${String(answer.choice)}`);
  }
  if (typeof answer.confidence !== "number" || !isNumberRecord(answer.probabilities)) {
    throw new Error("TypeSafe REST API returned an invalid next_action answer.");
  }

  return {
    action: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}

function describeError(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    if (typeof value.detail === "string") return value.detail;
    if (isRecord(value.detail) && typeof value.detail.message === "string") {
      return value.detail.message;
    }
    if (typeof value.message === "string") return value.message;
  }
  return JSON.stringify(value);
}

function isAgentAction(value: unknown): value is AgentAction {
  return (
    value === "inspect" ||
    value === "think" ||
    value === "run_command" ||
    value === "write_file" ||
    value === "finish"
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
