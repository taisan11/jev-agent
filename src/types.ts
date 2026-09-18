export type AgentAction = "inspect" | "think" | "run_command" | "write_file" | "finish";

export type TimelineKind =
  | "user"
  | "status"
  | "decision"
  | "thought"
  | "tool"
  | "result"
  | "assistant"
  | "error";

export type TimelineEvent = {
  kind: TimelineKind;
  text: string;
};

export type AgentContext = {
  task: string;
  workspace: string;
  history: string[];
  sessionSummary: string;
};

export type ApprovalRequest = {
  action: "run_command";
  summary: string;
  detail: string;
};

export type AgentCallbacks = {
  onEvent: (event: TimelineEvent) => void;
  approve: (request: ApprovalRequest) => Promise<boolean>;
};

export type CodexToolCall = {
  name: "run_command" | "write_file";
  arguments: Record<string, unknown>;
};
