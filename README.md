# Message Mover

Discordのメッセージをチャンネル間で移動するボット。[Pippin the Mover](https://pippin.gg) と同じ機能を実装しています。

## 機能

| コンテキストメニュー | 説明 |
|---|---|
| **Move this** | 選択したメッセージを別のチャンネルやスレッドに移動 |
| **Move this & below** | 選択したメッセージ以降のメッセージ（最大100件）を一括移動 |
| **Move thread / forum** | スレッド内の全メッセージを別チャンネルの新スレッドとして移動 |

### 特徴
- 元のメッセージ作者の名前・アバターを保持（Webhook使用）
- 絵文字リアクションを保持（移動先にフッターとして表示）
- 添付ファイル・GIF・リンクを保持
- 移動後に元メッセージを削除するか選択可能

## セットアップ

### 1. ボットの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. **Bot** タブでボットを作成し、トークンをコピー
3. **Privileged Gateway Intents** で **Message Content Intent** を有効化

### 2. 必要な権限

ボットを招待する際に以下の権限が必要です:

- `Manage Webhooks` (メッセージの送信先に使用)
- `Manage Messages` (元メッセージの削除)
- `Read Message History`
- `Send Messages`

権限コード: `536939520`

招待URL例:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=536939520&scope=bot%20applications.commands
```

### 3. インストール

```bash
git clone <this repo>
cd message-mover
npm install
cp .env.example .env
# .env を編集して BOT_TOKEN と CLIENT_ID を設定
```

### 4. コマンドの登録

```bash
# テスト用（特定サーバーに即時反映）
GUILD_ID=your_guild_id npm run deploy

# 本番用（全サーバー・最大1時間で反映）
npm run deploy
```

### 5. 起動

```bash
npm start
```

## 使い方

1. 移動したいメッセージを右クリック（モバイルは長押し）
2. **アプリ** → 目的のアクションを選択
3. 移動先チャンネルを選択
4. 元メッセージを削除するか選択

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `BOT_TOKEN` | ✅ | Discordボットトークン |
| `CLIENT_ID` | ✅ | ボットのアプリケーションID |
| `GUILD_ID` | - | テスト用サーバーID（省略時はグローバル登録） |
