import { jevModel, typesafeApiKey, typesafeBaseUrl } from "../config.ts";
import { callTypesafeSystemOne } from "./typesafe-rest.ts";

export type JevAction = "inspect" | "think" | "run_command" | "write_file" | "finish";

export interface DecideActionInput {
  task: string;
  workspace: string;
  sessionSummary: string | null;
  recentHistory: string[];
}

export interface JevDecision {
  action: JevAction;
  confidence: number;
}

const ACTIONS: JevAction[] = ["inspect", "think", "run_command", "write_file", "finish"];

function recentActions(history: string[]): JevAction[] {
  return history
    .map((entry) => {
      const match = entry.match(/jev decision:\s*(inspect|think|run_command|write_file|finish)\b/);
      return match?.[1] as JevAction | undefined;
    })
    .filter((action): action is JevAction => action !== undefined);
}

function repeatedTail<T>(items: T[], value: T): number {
  let count = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i] !== value) break;
    count += 1;
  }
  return count;
}

function hasRecentInspectResult(history: string[]): boolean {
  return history.some((entry) => entry.startsWith("inspect (local recursive read):"));
}

function buildPrompt(input: DecideActionInput): string {
  const actions = recentActions(input.recentHistory);
  const lastAction = actions.at(-1) ?? null;
  const repeatedLastActionCount = lastAction === null ? 0 : repeatedTail(actions, lastAction);
  const inspected = hasRecentInspectResult(input.recentHistory);

  return `
タスク:
${input.task}

ワークスペース:
${input.workspace}

利用可能なアクション:
- inspect: まだ必要なファイル構造や内容が不足しているときだけ、ワークスペースを読む
- think: 既にある情報を整理し、次の編集・コマンド・完了判断を明確にする
- run_command: テスト、型チェック、lint、調査コマンドが必要なときに実行する
- write_file: 修正内容が明確なときにファイルへ書き込む
- finish: タスクが完了した、またはこれ以上の変更が不要なときに終了する

ループ防止の最重要ルール:
1. 直前と同じアクションを安易に選ばない。
2. 進捗がないアクションは避ける。
3. 同一アクションが2回以上続いている場合は、原則として必ず別アクションへ遷移する。
4. 進捗を生まない再調査を避ける。情報が不足している理由を具体的に説明できない inspect は選ばない。
5. write_file 後は、必要なら run_command で検証し、検証不要または完了済みなら finish を選ぶ。
6. run_command 後に結果が十分なら finish、失敗が明確なら write_file、判断に迷うときのみ think を選ぶ。
7. ユーザーの依頼がプロンプト改善や小規模修正で、既に関連ファイルが推測できる場合は、inspect を繰り返さず write_file に進む。

現在のループ状況:
- 直前のアクション: ${lastAction ?? "なし"}
- 直前と同じアクションの連続回数: ${repeatedLastActionCount}
- 既にinspect結果がある: ${inspected ? "はい" : "いいえ"}

${input.sessionSummary ? `セッション要約:\n${input.sessionSummary}\n` : "セッション要約: なし\n"}
直近履歴:
${input.recentHistory.length === 0 ? "なし" : input.recentHistory.join("\n\n---\n\n")}

選択方針:
- 変更すべきファイルと内容が十分に分かるなら write_file。
- 変更後の確認が必要なら run_command。
- 何をすべきかは分かるが、書き込み前に短く計画を固める必要があるなら think。
- すべて終わっているなら finish。
- inspect は「未読の具体的な情報がなければ次へ進めない」場合だけ。

上記ルールに従って、次のアクションを1つだけ選んでください。`;
}

function normalizeDecision(value: unknown): JevDecision {
  if (typeof value !== "object" || value === null) {
    return { action: "think", confidence: 0.2 };
  }
  const record = value as Record<string, unknown>;
  const action = record.action;
  const confidence = record.confidence;
  return {
    action: ACTIONS.includes(action as JevAction) ? (action as JevAction) : "think",
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0.5,
  };
}

function avoidLocalLoop(decision: JevDecision, input: DecideActionInput): JevDecision {
  const actions = recentActions(input.recentHistory);
  const lastAction = actions.at(-1);
  const repeatedCount = lastAction === undefined ? 0 : repeatedTail(actions, lastAction);
  const inspected = hasRecentInspectResult(input.recentHistory);

  if (decision.action === "inspect" && inspected) {
    return { action: "think", confidence: Math.max(decision.confidence, 0.65) };
  }

  if (lastAction === decision.action && repeatedCount >= 2) {
    if (decision.action === "inspect") return { action: "think", confidence: 0.7 };
    if (decision.action === "think") return { action: "write_file", confidence: 0.62 };
    if (decision.action === "write_file") return { action: "run_command", confidence: 0.62 };
    if (decision.action === "run_command") return { action: "finish", confidence: 0.6 };
  }

  return decision;
}

export async function decideNextAction(input: DecideActionInput): Promise<JevDecision> {
  const apiKey = typesafeApiKey();
  const baseUrl = typesafeBaseUrl();
  const prompt = buildPrompt(input);

  const response = await callTypesafeSystemOne({
    apiKey,
    baseUrl,
    model: jevModel(),
    prompt,
    choices: ACTIONS,
  });

  return avoidLocalLoop(normalizeDecision(response), input);
}
