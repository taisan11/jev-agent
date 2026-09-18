import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { JevAgent } from "../agent/agent.ts";
import type { ApprovalRequest, TimelineEvent } from "../types.ts";

type TuiOptions = {
  initialTask?: string;
  autoApprove?: boolean;
};

const colors = {
  background: "#111827",
  panel: "#1f2937",
  text: "#e5e7eb",
  muted: "#9ca3af",
  accent: "#67e8f9",
  green: "#86efac",
  yellow: "#fde68a",
  red: "#fca5a5",
};

export async function runTui(options: TuiOptions = {}): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: colors.background,
  });
  const timeline: string[] = [];
  let running = false;
  let pendingApproval: { resolve: (approved: boolean) => void } | undefined;

  const root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
    padding: 1,
  });
  const header = new TextRenderable(renderer, {
    content: " JEV // TypeSafe routing + Codex execution ",
    fg: colors.accent,
  });
  const log = new TextRenderable(renderer, {
    width: "100%",
    content: "タスクを入力してください。Ctrl+Cで終了します。",
    fg: colors.text,
    wrapMode: "word",
    selectable: true,
    selectionBg: "#475569",
    selectionFg: "#ffffff",
  });
  const logViewport = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    border: true,
    borderColor: "#374151",
    padding: 1,
  });
  const status = new TextRenderable(renderer, {
    content: "ready",
    fg: colors.muted,
  });
  let statusText = "ready";
  let input!: InputRenderable;

  const redraw = () => {
    log.content =
      timeline.length > 0
        ? timeline.join("\n\n")
        : "タスクを入力してください。Ctrl+Cで終了します。";
    logViewport.scrollTo({ x: 0, y: 999_999 });
  };

  const setStatus = (text: string, color = colors.muted) => {
    statusText = text;
    status.content = text;
    status.fg = color;
  };

  const approve = (request: ApprovalRequest): Promise<boolean> => {
    if (options.autoApprove) return Promise.resolve(true);
    input.blur();
    setStatus(`承認待ち: ${request.action} — y:実行 / n:拒否`, colors.yellow);
    timeline.push(`⚠ ${request.action}\n${request.summary}\n${request.detail}`);
    redraw();
    return new Promise((resolve) => {
      pendingApproval = { resolve };
    });
  };

  const submit = async () => {
    const task = input.value.trim();
    if (!task || running || pendingApproval) return;
    input.value = "";
    running = true;
    setStatus("running", colors.accent);
    try {
      const agent = new JevAgent();
      await agent.run(task, {
        onEvent(event) {
          addEvent(timeline, event);
          redraw();
          if (event.kind === "status") setStatus(event.text, colors.accent);
          if (event.kind === "assistant") setStatus("ready", colors.green);
          if (event.kind === "error") setStatus("error", colors.red);
        },
        approve,
      });
    } catch (error) {
      addEvent(timeline, { kind: "error", text: String(error) });
      redraw();
      setStatus("error", colors.red);
    } finally {
      running = false;
      if (!pendingApproval) {
        input.focus();
        if (statusText === "running") setStatus("ready", colors.green);
      }
    }
  };

  input = new InputRenderable(renderer, {
    width: "100%",
    value: "",
    placeholder: "Ask jev to inspect, change, or test this workspace...",
    backgroundColor: colors.panel,
    focusedBackgroundColor: "#263449",
    textColor: colors.text,
    focusedTextColor: colors.text,
  });
  input.on("enter", () => void submit());

  root.add(header);
  logViewport.add(log);
  root.add(logViewport);
  root.add(status);
  root.add(input);
  renderer.root.add(root);
  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.shift && key.name.toLowerCase() === "c") {
      key.preventDefault();
      const selection = renderer.getSelection();
      const selectedText = selection?.getSelectedText() ?? "";
      if (!selectedText) {
        setStatus("コピーするテキストが選択されていません", colors.yellow);
        return;
      }

      const copied = renderer.copyToClipboardOSC52(selectedText);
      setStatus(
        copied ? "選択テキストをコピーしました" : "端末がOSC52コピーに対応していません",
        copied ? colors.green : colors.red,
      );
      return;
    }

    if (!pendingApproval) return;
    if (key.name !== "y" && key.name !== "n") return;
    key.preventDefault();
    const approval = pendingApproval;
    pendingApproval = undefined;
    approval.resolve(key.name === "y");
    input.focus();
  });

  input.focus();
  if (options.initialTask) {
    input.value = options.initialTask;
    queueMicrotask(() => void submit());
  }
}

function addEvent(timeline: string[], event: TimelineEvent): void {
  const labels: Record<TimelineEvent["kind"], string> = {
    user: "YOU",
    status: "STATUS",
    decision: "JEV",
    thought: "CODEX / THINK",
    tool: "CODEX / TOOL",
    result: "TOOL RESULT",
    assistant: "CODEX / SUMMARY",
    error: "ERROR",
  };
  timeline.push(`[${labels[event.kind]}]\n${event.text}`);
}
