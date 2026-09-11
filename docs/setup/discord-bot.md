# Discord Bot のセットアップ

yachi8000 専用の Discord Application / Bot を作る手順。**既存の Bot は流用しない。**

調査日: 2026-09-11（出所: [Discord 公式ドキュメント](https://docs.discord.com/developers/events/gateway)）

---

## なぜ専用の Bot が必要か

環境に既存の Discord Bot が 2 つあるが、どちらも流用しない。

| 既存 | 用途 | 流用しない理由 |
|---|---|---|
| `DISCORD_VC_BOT_TOKEN` | `discord-vc` プラグイン | **Gateway 接続を張る**（`Guilds` / `GuildVoiceStates`）。同じトークンで yachi8000 も繋ぐと単一トークンで複数 Gateway 接続になる（→ Q-13） |
| `DISCORD_BOT_TOKEN`（pass） | `discord` プラグイン | REST API のみ（`discord.com/api/v10`）なので接続の競合はしないが、**Bot の名前・アイコンがキャラクターと一致しない** |

2 つは別のトークンであることをハッシュ比較で確認済み。

**クラスタ上の他のアプリは Discord の認証情報を持っていない**（確認済み）。インフラ定義リポジトリ内の Discord 参照は監視通知の Webhook URL だけで、これは**一方向の投稿専用**であり VC 参加も受信もできない。

---

## 1. Gateway Intents

Developer Portal の **Bot → Privileged Gateway Intents** で切り替える。

### 必須（特権ではない。コード側で指定するだけ）

| Intent | 値 | 何に要るか |
|---|---|---|
| `GUILDS` | `1 << 0` | ギルド・チャンネルの基本情報 |
| `GUILD_VOICE_STATES` | `1 << 7` | **VC の参加状態**。誰が VC に居るかを知る（F-11） |
| `GUILD_MESSAGES` | `1 << 9` | サーバのチャンネルでメッセージイベントを受け取る（F-01） |
| `DIRECT_MESSAGES` | `1 << 12` | **DM のメッセージイベント**（F-01 で DM は常に応答） |

### 特権インテント — **おそらく不要**

| Intent | 値 | 判断 |
|---|---|---|
| `MESSAGE_CONTENT` | `1 << 15` | **まず OFF で試す。** 下記の理由により、この設計では不要な可能性が高い |
| `GUILD_MEMBERS` | `1 << 1` | **不要。** 表示名は REST（`GET /guilds/{id}/members/{user_id}`）で取れる |

**`MESSAGE_CONTENT` が不要と見込む根拠**（公式ドキュメントの原文）:

> **Exceptions (accessible without the intent):**
> - Content in messages the app sends
> - **Content in DMs with the app**
> - **Content mentioning the app**
> - Content from messages where the app uses a message context menu command

F-01 の応答方針は「**DM は常に応答、サーバのチャンネルは明示的メンションがある場合のみ応答**」であり、**両方とも例外の範囲に収まる。**

この intent が gate しているのは `content` / `embeds` / `attachments` / `components` / `poll` の各フィールド。**特権インテント無しでもイベント自体は届き、上記の例外に当たる場合は content が入る。**

> **⚠ 実装時に必ず実機で確認すること。** ドキュメント上は不要だが、**本環境で「メンション付きメッセージの `content` が実際に空でないか」を確かめてから OFF で確定する。** 空だった場合は ON にする（Portal のトグルだけで済み、コード変更は intent の指定だけ）。

---

## 2. OAuth2 スコープ

**OAuth2 → URL Generator** で以下を選ぶ。

| スコープ | 何に要るか |
|---|---|
| `bot` | Bot としてサーバに参加する |
| `applications.commands` | **スラッシュコマンド**の登録（`/vc-join` `/vc-leave` 相当、スキルの承認・却下 → F-11, F-41） |

---

## 3. Bot 権限（Bot Permissions）

同じ URL Generator で選ぶ。**生成される招待 URL の `permissions=` に反映される。**

### テキスト対話（F-01, F-03）

- **View Channels** — チャンネルを見る
- **Send Messages** — 応答を送る
- **Read Message History** — 文脈の取得
- **Embed Links** — 整形した応答（表示整形は interfaces 層の責務）
- **Attach Files** — 必要に応じて

### 音声（F-11, F-12, F-13）

- **Connect** — VC に参加する。**音声の受信もこれで足りる**（受信専用の権限は無い）
- **Speak** — VC で音声を再生する
- **Use Voice Activity** — プッシュ・トゥ・トークを強制されている VC でも発話できるようにする

### スキルの承認フロー（F-41, F-43）

- **Add Reactions** — リアクションで承認・却下する形にする場合
- メッセージのボタン・セレクトメニューは **Send Messages だけで動く**（追加権限は不要）

### 不要なもの

- **Administrator** は付けない。必要な権限だけを個別に選ぶ
- **Manage Messages** / **Mention Everyone** / **Manage Server** はいずれも不要

---

## 4. トークンの保管

取得したトークンは平文をどこにも残さず、pass へ入れる。

```bash
pass insert YACHI8000/DISCORD_BOT_TOKEN
```

**`.env` や設定ファイルに直接書かない。** k8s へは Sealed Secret 経由で渡す（→ D-14 / house rule 9 章）。

---

## 5. 作成後のチェックリスト

- [ ] Bot の名前・アイコンがキャラクター設定と一致している（→ F-32、人格設定と揃える）
- [ ] 対象サーバに招待済み（`bot` + `applications.commands` スコープ）
- [ ] Bot が VC に参加できる（`Connect`）
- [ ] `pass show YACHI8000/DISCORD_BOT_TOKEN` が引ける
- [ ] **メンション付きメッセージの `content` が空でないことを実機で確認**（→ `MESSAGE_CONTENT` を OFF のままにしてよいかの判断）
- [ ] `DISCORD_VC_BOT_TOKEN`（discord-vc プラグイン）とは**別のトークン**である
