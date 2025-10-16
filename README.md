# Slack Patrol Bot

Slack チャンネル内の「@メンションなし」「スレッド外返信」「短時間の連投」を検知し、対象ユーザーへ Ephemeral メッセージで注意喚起するボットです。Socket Mode で動作し、必要に応じて Google スプレッドシートへログを送信できます。

## 機能と前提
- 監視対象チャンネルは `config.json` のリスト（include モード）。
- 同一ユーザー／チャンネルへの注意はクールダウン秒数内で抑止。
- 複数ルール発火時は最初の注意後に以降の判定をスキップ。
- ログ送信は Apps Script ウェブアプリへの POST（任意機能）。
- 標準出力に加えて `logs/` 配下へ永続ログを追記（レベルは環境変数または設定で変更可能）。
- 起動時に環境変数と `config.json` の整合性をチェックし、不正な設定を早期に検出。

## 必要要件
- Node.js 18 以上。
- Slack アプリ（Socket Mode 利用可）が作成済みで、管理者権限があること。
- （任意）Google Apps Script で誰でもアクセス可能なウェブアプリ URL を発行できること。

## セットアップ手順

### 1. 依存パッケージのインストール
```bash
npm install
```

### 2. Slack アプリの準備
1. [https://api.slack.com/apps](https://api.slack.com/apps) で新規アプリを作成（From scratch）。
2. **App-Level Token** を発行し、スコープ `connections:write` を付与 → 値を `SLACK_APP_TOKEN` として控える。
3. **Bot Token Scopes** に `chat:write` と `channels:history`（必要なら `users:read`）を追加。
4. **Event Subscriptions** を有効化し、Bot イベントに `message.channels` を登録。
5. **Socket Mode** を ON にする。
6. ワークスペースへインストールし、表示される Bot User OAuth Token を `SLACK_BOT_TOKEN` として控える。
7. 監視対象チャンネルそれぞれで `/invite @Bot名` を実行し、ボットを参加させる。

> スコープやイベント設定を変更した場合は、再度ワークスペースへインストールしてトークンを更新してください。

### 3. 環境変数の設定
1. `.env.example` をコピーして `.env` を作成。
2. `SLACK_BOT_TOKEN` と `SLACK_APP_TOKEN` に取得した値を設定。
3. ログ送信を使わない場合は `SHEETS_WEBHOOK_URL` を空のままにする。
4. 調査用に詳細ログを見たい場合は `APP_ENV=development` や `LOG_LEVEL=debug` を設定するとデバッグログがファイル／コンソール双方に出力される。
5. ログの出力先を変えたい場合は `LOG_FILE` にパスを指定（相対パスはプロジェクトルート基準）。
6. ポートを変更したい場合は `PORT` を任意値に。

### 4. 監視設定ファイルの調整
- `config.json`
  - `"channels"` に監視対象チャンネルの ID（`Cxxxx` 形式）を列挙。
  - クールダウンや連投判定の閾値を必要に応じて調整。
- `messages.json`
  - 注意文を組織向けの文言に編集可。

### 5. 実行
```bash
node index.js
# あるいは
npm start
```

コンソールや `logs/app.log` に `⚡️ Slack Patrol Bot が起動しました` が出力されれば Socket Mode 接続が完了しています。テスト時は監視チャンネルで通常メッセージを投稿し、期待通りに Ephemeral 通知が届くか、必要に応じて `APP_ENV=development npm start` や `LOG_LEVEL=debug node index.js` のように起動して詳細ログを確認してください。

## ログ出力と調査モード
- ログは標準出力とファイルに同時出力されます。既定では `logs/app.log`、`APP_ENV=development` の場合は `logs/dev.log` に追記されます（存在しない場合は起動時にディレクトリごと作成）。
- ログレベルは `LOG_LEVEL` 環境変数（`error` / `warn` / `info` / `debug`）か、`config.json` の `logging.level` で指定できます。環境変数が優先され、指定がなければ `APP_ENV=development` 時は `debug`、それ以外は `info` になります。
- 出力先ファイルは `LOG_FILE` 環境変数、または `config.json` の `logging.file` で変更可能です。相対パスはプロジェクトルート基準で解釈されます。
- 調査時は `npm start --silent` のように起動して `tail -f logs/app.log` でファイルを監視すると便利です。大量のデバッグログが不要な場合は `LOG_LEVEL=info` で抑制できます。

## テスト
- 依存インストール後（`npm install`）に `npm test` を実行すると、`looksLikeReplyText` の判定ロジックと連投判定の時間ウインドウ trimming が `vitest` で検証されます。
- テスト時は `NODE_ENV=test` が自動的に判定され、Slack への接続処理はスキップされます。必要に応じて `.env` を読み込んだままでも問題ありません。

## Google スプレッドシート連携（任意）
1. スプレッドシートを作成し、シート名 `logs` を用意。
2. Apps Script で以下のような `doPost` スクリプトを作成。
   ```javascript
   function doPost(e) {
     const body = JSON.parse(e.postData.contents || '{}');
     const sheet = SpreadsheetApp.getActive().getSheetByName('logs') || SpreadsheetApp.getActive().insertSheet('logs');
     sheet.appendRow([
       body.timestamp || new Date().toISOString(),
       body.rule || '',
       body.user || '',
       body.channel || '',
       body.ts || '',
       body.text || '',
       body.count || ''
     ]);
     return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
   }
   ```
3. **デプロイ → ウェブアプリ** を選択し、実行者を「自分」、アクセス権を「全員（匿名含む）」に設定してデプロイ。
4. ダイアログに表示される `https://script.google.com/macros/s/.../exec` 形式の URL を `.env` の `SHEETS_WEBHOOK_URL` に設定。

### セキュリティ注意
- Apps Script を「全員」に公開すると匿名アクセスを受け入れるため、URL が漏洩すると誰でも書き込めます。  
  - 安全性を高めたい場合は Cloud Functions / Cloud Run + IAM など認証付きエンドポイントを検討してください。
- ログに含める情報は最小限にし、必要であればスクリプト側でフィルタリング・マスキングを行ってください。

## 設定項目リファレンス

### `.env`
- `SLACK_BOT_TOKEN`：Bot User OAuth Token。`xoxb-` で始まる値。権限変更後は再取得が必要。
- `SLACK_APP_TOKEN`：App-Level Token。Socket Mode 用で `xapp-1-` で始まる。`connections:write` スコープ必須。
- `APP_ENV`：`development` を指定するとデバッグログが有効になり、既定のログファイルが `logs/dev.log` へ切り替わります。未指定時は `production` として扱われます。
- `LOG_LEVEL`：ログレベルを強制的に指定（`error` / `warn` / `info` / `debug`）。未指定時は `APP_ENV` や `config.json` に従います。
- `LOG_FILE`：ログファイルのパス。相対パスはプロジェクトルート基準、絶対パスも指定可能。
- `SHEETS_WEBHOOK_URL`：Apps Script など外部ログ集約先の HTTPS URL。空欄にするとログ送信を無効化。
- `PORT`：`app.start()` の待受ポート。Socket Mode なので外部公開不要だが、Procfile 等で指定する場合に利用。

### `config.json`
- `mode`：`"include"`（指定チャンネルのみ監視）または `"exclude"`（指定チャンネル以外を監視）。Bot を複数チャンネルに入れる場合は include 指定が安全。
- `channels`：監視対象または除外対象のチャンネル ID 配列。Public/Private いずれも `C...` 形式（Private は `G...`）。Bot を必ず招待。
- `cooldown_sec_user`：同一ユーザーに再注意するまでの最小秒数。短くすると連続注意が増えるので検証時以外は数分以上推奨。
- `cooldown_sec_channel`：同一チャンネル全体への注意クールダウン。大きめにすると通知スパムを防げる。
- `flood_window_sec`：連投判定で参照する過去秒数。短くすると瞬間的な連投のみに反応。
- `flood_max_posts`：`flood_window_sec` 内の投稿閾値。指定値以上で連投注意。
- `rules.no_mention`：`true` で @なし判定を有効化。`false` にすれば無効。
- `rules.non_thread_reply`：スレッド外返信ヒューリスティックの有効／無効。
- `rules.flood`：連投判定の有効／無効。
- `logging.level`：既定のログレベル。`error` / `warn` / `info` / `debug` のいずれか。環境変数 `LOG_LEVEL` による指定がある場合はそちらが優先されます。
- `logging.file`：ログ出力先ファイル。相対パスはプロジェクトルート基準で解釈され、存在しない場合は起動時に作成されます。

#### 設定サンプル
```json
{
  "mode": "exclude",
  "channels": ["CGEN12345"],   // 例: 雑談チャンネルだけ監視対象外にする
  "cooldown_sec_user": 120,    // 2分で再通知許可
  "cooldown_sec_channel": 900, // チャンネル全体は15分に1回まで
  "flood_window_sec": 30,
  "flood_max_posts": 4,
  "rules": {
    "no_mention": true,
    "non_thread_reply": false, // スレッド判定だけ無効化
    "flood": true
  },
  "logging": {
    "file": "logs/app.log",
    "level": "info"
  }
}
```

### `messages.json`
- `no_mention`：@無し投稿時に表示する文言。`<@user>` の自動挿入は行わないため、単純な注意文にする。
- `non_thread_reply`：スレッド誘導のメッセージ。長文にする際は Ephemeral でも読みやすいよう改行や絵文字で調整。
- `flood`：連投注意メッセージ。投稿数などを動的に伝えたい場合は `appendLog()` と同様に `index.js` を拡張して差し込み。

## カスタマイズ例
- `config.json`：`mode` を `exclude` に変更して除外リスト運用に切り替えたり、`cooldown_sec_user` / `cooldown_sec_channel` を環境に合わせて調整できます。`rules` のフラグを `false` にすると特定ルールを無効化できます。
- `messages.json`：注意文の語尾や絵文字、マークダウンを編集して組織向けのトーンに合わせられます。
- `lib/textRules.js`：`looksLikeReplyText()` の正規表現を拡張すると新しい返信パターンを検知できます。テスト (`tests/rules.test.js`) も合わせて更新すると安全です。
- `lib/floodUtils.js`：`ensureWindowMs` や `trimTimestamps` を調整することで連投判定のウインドウ計算を変更できます。
- `index.js` の `appendLog()`：送信項目を増減したり、Apps Script 以外のエンドポイント（例: Cloud Functions, Datadog）へ差し替える場合に編集します。
- `config.logging`：本番のみ詳細ログを抑制したい場合は `logging.level` を `info` にし、必要に応じて `APP_ENV=development` と組み合わせて調査環境でだけ `debug` ログを出す運用が可能です。
- 環境変数：Slack Webhook など別の通知手段を追加したい場合は `.env` に新しいキーを設け、`index.js` から参照する形で拡張します。

## 運用とトラブルシューティング
- **注意メッセージが1回しか出ない**  
  - `config.json` の `cooldown_sec_user` / `cooldown_sec_channel` によりクールダウンされています。検証時は値を短縮するか、ボットを再起動してメモリを初期化してください。
- **イベントが届かない**  
  - Bot がチャンネルに招待されているか、`message.channels` イベントが有効か、`channels:history` スコープが付いているかを確認。
- **`log post failed: 401`**  
  - `SHEETS_WEBHOOK_URL` の URL 形式とアクセス権を再確認。Apps Script の `/a/<domain>` 付き URL では匿名アクセスできません。
- **接続に失敗する**  
  - ワークスペースで Socket Mode が許可されているか確認し、必要に応じてプロキシ／ファイアウォール設定を調整。

## プロジェクト構成
```
.
├─ index.js
├─ config.json
├─ messages.json
├─ package.json / package-lock.json
├─ README.md（本書）
├─ .env（ローカル専用・コミット不要）
├─ .env.example
├─ lib/（判定ロジックなどのユーティリティ）
├─ tests/（vitest のテストケース）
└─ logs/（起動時に自動作成されるログディレクトリ）
```
