# yachi8000

3D キャラクターの姿を持つパーソナル AI アシスタント。

音声で会話し、Discord / Slack からチャット・リマインダー・日常タスクの依頼を受ける。会話を重ねるほど自分でスキルを増やしていくことを目指す。

> **ステータス: 実装フェーズ 3（外部通知）まで完了・未リリース。**
> **フェーズ 3.5（リマインダー・Web 検索）と 4（スキル自己改善・人格の記録）は実装済みですが、まだデプロイしていません。**
> 実装は [`agent/`](agent/)。要件の正典は引き続き [`docs/requirements/`](docs/requirements/INDEX.md) です。

## 目指すもの

- **姿がある**: VRM の 3D モデルがブラウザ上で表情・口・視線を動かし、会話に反応する
- **声で話せる**: Discord のボイスチャンネルに常駐し、呼びかけると音声で応答する
- **どこからでも頼める**: Discord / Slack のテキストからリマインダー・タスクを依頼できる
- **外の出来事を伝える**: 外部システムから HTTP で通知を受け取り、通話中の VC に割り込んで「○○ からのメッセージです。〜」と読み上げる
- **自分好みに仕立てられる**: 名前・人格・口調・3D モデル・声を、設定ファイルからも画面からも変えられる
- **人格が育つ**: 会話から得た知識・好み・約束を長期記憶として保持する。変化は記録され、いつでも戻せる。変わってほしくないときは**人格・口調固定モード**にする
- **自分で覚える**: 繰り返し発生するやり取りをスキルとして自動で切り出し、承認を経て以後の応答に反映する
- **調べてくれる**: 知らないことは Web 検索で調べてから答える
- **忘れない**: 日時を指定したリマインダーが、期限に**書いたままの文面で**チャンネルと VC へ届く

## アーキテクチャ（計画）

```
                        ┌──────────────────────────────┐
      ブラウザ ────────▶│  web/  アバター表示 + 設定UI  │
      (WebGL)           │  three.js + @pixiv/three-vrm │
                        └──────────────┬───────────────┘
                                       │ WebSocket（発話イベント / 表情 / リップシンク）
                                       ▼
   Discord VC ──音声────▶┌─────────────────────────────┐──▶ VOICEVOX（音声合成 / 別Deployment）
   Discord/Slack テキスト│  agent/  Flue アプリ         │──▶ LLM プロキシ（LiteLLM / OpenAI 互換）
         （chat）  ─────▶│  エージェント・ツール・スキル │──▶ SQLite（会話履歴 / リマインダー・スキル・人格差分）
                         │                             │──▶ Brave Search API（Web 検索）
   外部システム ─通知API─▶│                             │──▶ Postgres + pgvector（長期記憶 / RAG）
    （要トークン認証）    └─────────────────────────────┘
```

**外部通知 API**: トークンを添えてメッセージ本文を POST すると、通話中の VC に割り込んで読み上げます。文面は LLM が自然文に書き換えます（「作業が完了しました。」→「claude-code からのメッセージです。作業が完了したみたいです。」）。任意の `role`（「CI を直している人」など）を添えると、**同じ送信元が並行して動いていても何の通知か分かります**。Claude Code の `discord-vc` プラグインが持っていたバックエンド機能を、汎用の入口として本体に取り込んだものです。**アシスタントに任意の発話をさせられる入口なので、トークン認証を必須にします。送信元はトークンから決まり、本文には名乗らせません。**

割り込みは**文の切れ目**で起きます（再生中の音声は切りません）。通知は会話の応答より先に読まれ、同じ優先度なら投入順です。短時間に多数来ても全部読みますが、キューの上限を超えた分は破棄してログに残します（→ D-22）。

**「ビデオ通話」の実現方式について**: Discord Bot は公式 API で映像を送信できず（音声のみ）、Slack Huddle には API がありません。そのため映像は Discord へ流さず、**アバターは自前の Web ページで描画し、音声だけを Discord VC でやりとりする**構成を採ります。非公式手段（selfbot 等）は採用しません。詳細と根拠は [`docs/requirements/02-constraints.md`](docs/requirements/02-constraints.md) にあります。

## 技術スタック

| 領域 | 採用 |
|---|---|
| フレームワーク | [Flue Framework](https://flueframework.com/) 2.x（TypeScript / Node.js 22+） |
| LLM | LLM プロキシ（LiteLLM ベースの OpenAI 互換プロキシ）経由。**API キー方式のモデルのみ** |
| 音声合成 | VOICEVOX Engine **CPU 版**（**独立した Deployment**。接続情報のみ渡すので運用者が差し替え可能） |
| 音声入出力 | Discord ボイスチャンネル（`@discordjs/voice`）。STT はさくらの AI Engine の Whisper |
| アバター | three.js + `@pixiv/three-vrm`（ブラウザで描画） |
| 永続化 | 会話履歴は Flue 組み込みの SQLite（`node:sqlite`）+ 自動圧縮。リマインダー・スキル・人格差分は**別ファイルの SQLite**。長期記憶は **Postgres + pgvector** |
| Web 検索 | Brave Search API（API キー 1 本） |
| 品質 | TypeScript strict / Biome / Vitest |
| デプロイ | 自宅 Kubernetes（インフラ定義リポジトリ + ArgoCD GitOps） |

## 前提環境

- Node.js 22.19 以上 / **npm 11 以上**（npm 10 系は依存解決が [arborist のバグ](https://github.com/npm/cli/issues/9787)で落ちる）
- Docker / Docker Compose（`compose.yaml` が開発時の依存サービスを起動する）
- **yachi8000 専用の Discord Bot** — 既存の Bot は流用しない。手順は [docs/setup/discord-bot.md](docs/setup/discord-bot.md)
- LLM プロキシが到達可能であること
- **Brave Search API のキー**（[ダッシュボード](https://api-dashboard.search.brave.com/)で発行。Free プランで足りる）。**未設定だと起動時に落ちます**
- VRM 形式の 3D モデルファイル

## 開発をはじめる

```bash
docker compose up -d                  # pgvector（長期記憶）と VOICEVOX（音声合成）を起動
cd agent
npm install
cp .env.example .env                  # 接続先と認証情報を埋める
mkdir -p data && cp settings.example.yaml data/settings.yaml    # 名前・人格・口調・声
npm run dev
```

通知 API のトークンは `NOTIFY_TOKENS` に `送信元:トークン` のカンマ区切りで入れます（`openssl rand -hex 32` で生成）。

```bash
# VC に参加させたうえで（Discord 上で /vc-join）、通知を投げる
curl -X POST http://localhost:5173/api/v1/notify \
  -H "Authorization: Bearer $YACHI8000_NOTIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"作業が完了しました。"}'

# role（任意）を添えると「何をしている人からの通知か」が読み上げに乗る
curl -X POST http://localhost:5173/api/v1/notify \
  -H "Authorization: Bearer $YACHI8000_NOTIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"作業が完了しました。","role":"CI を直している人"}'
```

`DEBUG_MODE=true` のときだけ、Discord を経由せずに 1 ターン試せる入口が生えます（`/debug/vc-join`・`/debug/vc-leave` も同様）。

```bash
curl -X POST http://localhost:5173/debug/chat \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"debug","text":"はじめまして"}'
```

| コマンド（`agent/` 配下） | 内容 |
|---|---|
| `npm run dev` | 開発サーバ（Vite） |
| `npm run build` / `npm start` | 本番ビルド / 起動 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Biome + 依存方向の検査 |
| `npm test` | Vitest |

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/requirements/INDEX.md](docs/requirements/INDEX.md) | 要件定義の目次 |
| [01-overview.md](docs/requirements/01-overview.md) | 目的・スコープ・非スコープ |
| [02-constraints.md](docs/requirements/02-constraints.md) | 前提と制約（出所付き） |
| [03-functional.md](docs/requirements/03-functional.md) | 機能要件 |
| [04-architecture.md](docs/requirements/04-architecture.md) | アーキテクチャ方針 |
| [05-decisions.md](docs/requirements/05-decisions.md) | 決定事項 |
| [06-open-questions.md](docs/requirements/06-open-questions.md) | 未決事項 |
| [docs/setup/discord-bot.md](docs/setup/discord-bot.md) | **Discord Bot の作成手順**（intents / scopes / 権限） |
| [CLAUDE.md](CLAUDE.md) | 開発時のガイダンス |

## 関連プロジェクト

- 先行実装リポジトリ — Flue で書かれた LINE 版パーソナルアシスタント。エージェント構成とスキル自己改善ループの先行実装
- `discord-vc`（Claude Code プラグイン） — Discord VC + VOICEVOX + 通知読み上げの先行実装。**バックエンドは本体へ統合済み**で、v2.0.0 以降は通知 API を叩くだけのクライアント
- LLM プロキシ — LiteLLM ベースの OpenAI 互換プロキシ。開発時はローカル、運用時はクラスタ上のもの
- インフラ定義リポジトリ — 自宅 Kubernetes クラスタの ArgoCD / Helm 定義
