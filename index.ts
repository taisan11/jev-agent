import { login, logout } from "./src/auth/codex-oauth.ts";
import { codexModel, jevModel } from "./src/config.ts";

function printHelp(): void {
  console.log(`jev-agent

使い方:
  bun run index.ts login                    ChatGPT OAuthでログイン
  bun run index.ts                          OpenTUIを起動
  bun run index.ts "タスク"                  起動後にタスクを実行
  bun run index.ts "タスク" --yes            ツール承認を省略

環境変数:
  TYPESAFE_API_KEY  Jevのアクション判断用APIキー
  JEV_CODEX_MODEL   Codexモデル (default: ${codexModel()})
  JEV_JEV_MODEL     Jevモデル (default: ${jevModel()})
  JEV_AUTH_FILE     OAuth認証ファイルの保存先
  JEV_NO_BROWSER    1ならログインURLを自動で開かない
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "login") {
    await login();
    return;
  }
  if (command === "logout") {
    await logout();
    console.log("ログアウトしました。");
    return;
  }

  const autoApprove = args.includes("--yes") || args.includes("-y");
  const task = args.filter((arg) => arg !== "--yes" && arg !== "-y").join(" ");
  const { runTui } = await import("./src/ui/tui.ts");
  await runTui({ initialTask: task || undefined, autoApprove });
}

main().catch((error) => {
  console.error(`\nエラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
