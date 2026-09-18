# jev-agent

TypeSafe の Jev をルーターに据え、OpenAI公式SDKのCodexを実行モデルにした coding agent です。OpenTUIでターミナルUIを表示します。

## 役割分担

- Jev (TypeSafe REST API): `POST /v1/systemone` で `inspect` / `think` / `run_command` / `write_file` / `finish` の次アクションを構造化された `choice` として判断
- Codex (`openai`): Jevが選んだ思考内容、コマンド、ファイル内容を生成（`inspect`のファイル読み取りはCodexを経由しない）。履歴の定期要約と、同じ操作が続いた場合の改善助言も担当
- OpenTUI (`@opentui/core`): タスク入力、実行履歴、ステータス、コマンド実行の承認を表示

Jevは文章を生成する担当ではなく、状態と質問に対して型付きの判断を返します。判断結果に応じてCodexが具体的な作業を行う構成です。

## セットアップ

```bash
bun install
bun run index.ts login
```

`login` はChatGPT OAuthを開始し、Codex用のtokenを `~/.jev/auth.json` に保存します。tokenは期限前に自動refreshされます。

Jev用のTypeSafe API keyも設定してください。

```bash
export TYPESAFE_API_KEY="..."
```

不要になった認証情報は次で削除できます。

```bash
bun run index.ts logout
```

## 起動

```bash
bun run index.ts
```

入力欄にタスクを入力してEnterを押します。`Ctrl+C` で終了できます。コマンド実行では画面上に承認待ちが表示され、`y` で実行、`n` で拒否します。現在のワークスペース内へのファイル書き込みは自動で実行されます。

Jevが`finish`を選ぶまでアクションループを続けます。一定アクションごとにCodexが全履歴を要約し、その累積要約と直近履歴を次のJev判断へ渡します。同じ操作が連続した場合はCodexへ自動で改善案を相談します。`inspect`ではワークスペースのルートからディレクトリを再帰的に辿り、安全なテキストファイルをローカルで読み取ります。finish後はCodexがセッション全体（目的、実行内容、変更ファイル、テスト結果、残課題）を要約します。ログのテキストはマウスで選択でき、`Ctrl+Shift+C` で端末クリップボードへコピーできます（OSC52対応端末が必要です）。

起動時にタスクを渡すこともできます。

```bash
bun run index.ts "プロジェクトを確認してテストを通して"
```

コマンド実行の承認を省略する場合は明示的に `--yes` を付けます。

```bash
bun run index.ts "必要な修正を行って" --yes
```

## 設定

- `TYPESAFE_API_KEY`: Jevのアクション判断に必須
- `TYPESAFE_BASE_URL`: TypeSafe APIのベースURL（デフォルト `https://api.typesafe.ai`）
- `JEV_CODEX_MODEL`: Codexモデル（デフォルト `gpt-5.5`）
- `JEV_JEV_MODEL`: Jevモデル（デフォルト `jev-latest`）
- `JEV_CONTEXT_SUMMARY_INTERVAL`: 履歴を要約するアクション間隔（デフォルト `8`）
- `JEV_AUTH_FILE`: Codex OAuth認証ファイルの保存先
- `JEV_NO_BROWSER=1`: OAuth login時にURLを自動で開かない

ChatGPT-backed Codex endpointは通常のAPI key endpointとは別経路です。共有されたOAuth利用メモに基づく実装であり、endpointや仕様が将来変更される可能性があります。

## 開発時チェック

```bash
bunx tsc --noEmit
bunx oxlint src index.ts
bunx oxfmt --check src index.ts README.md
```
