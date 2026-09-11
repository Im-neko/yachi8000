# CLAUDE.md

このファイルは、このリポジトリのコードを扱う際に Claude Code (claude.ai/code) にガイダンスを提供します。

## 開発ステータス

**実装フェーズ・未リリース。フェーズ 3（外部通知）まで実装済み。**

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | Discord テキスト対話（F-01, F-02, F-04, F-30, F-32, F-60） | 実装済み |
| 2 | Discord 音声出力（F-11, F-12） | 実装済み |
| 3 | 外部通知（F-15〜F-19） | 実装済み |
| 4 | スキル自己改善 | 未着手 |
| 5 | Slack 連携 | 未着手 |
| 6 | アバター | 未着手 |
| 7 | 音声入力 | 未着手 |

要件の正典は引き続き `docs/requirements/`。実装は `agent/`。

互換性は意識しない。理想的な形に向けて自由に作り直してよい。互換のためだけのオプション・分岐を増やさないこと。常用に入った時点でこの節を更新する。

### フェーズ 1 で確認済みのこと

- `setProvider()` + `createProvider()` でカタログ外モデルを使う経路は**実機で通した**。モデルのメタデータ（コンテキスト長・単価）は LLM プロキシの `/model/info` から起動時に取得する。**推測で埋めない** —— コンテキスト長は Flue の自動圧縮の閾値になるため、0 を入れると会話が黙って壊れる
- `auth` には `ProviderAuth`（`{ apiKey }`）を渡す。`envApiKeyAuth()` の戻り値を直接渡すと型が合わない
- **`npm` は 11 以上が必要。** 10 系は arborist のバグ（npm/cli#9787）で依存解決が落ちる
- pgvector の公式イメージ（PG18）は **`/var/lib/postgresql` にマウントする**。`/var/lib/postgresql/data` へ直接マウントすると起動しない。k8s の PVC でも同じ
- **`MESSAGE_CONTENT` は OFF のままでよい。** 実機のギルドメッセージ 1 通で確認済み（`empty content` の WARN がゼロ）

### フェーズ 2・3 で確認済みのこと

- **`discord-vc` プラグインのバックエンドは yachi8000 へ統合済み。** プラグイン側に Bot は残っていない（v2.0.0 で `bot/` を削除し、通知 API を叩くだけの薄い MCP クライアント + hook になった）
- **`@discordjs/opus` はネイティブ拡張。** 公式 prebuild は glibc 2.31 / 2.35 のみで、bookworm（2.36）には無いためソースビルドになる。Dockerfile の deps ステージにだけ `python3 make g++` を置き、runtime へは成果物だけを運ぶ
- **リサンプリングは要らない。** `/audio_query` の結果に `outputSamplingRate: 48000` と `outputStereo: true` を入れれば、エンジンが Discord と同じ形（48kHz / 2ch / 16bit）で返す。既存 `discord-vc` の `resamplePcm` は移植していない
- 暗号化ライブラリは不要。Node 組み込みの `aes-256-gcm` で `@discordjs/voice` の要件を満たす（`generateDependencyReport()` で確認）。`@noble/ciphers` は xchacha20 側の純 JS フォールバックとして入れてある
- **`AudioPlayer` の `noSubscriber` は `Stop` にする。** 既定の `Pause` は購読者がいないと Idle にならず、再生ループが永久に待つ

## プロジェクト概要

yachi8000 は、3D キャラクターの姿を持つパーソナル AI アシスタント。音声で会話し、Discord / Slack からチャット・リマインダー・日常タスクの依頼を受ける。外部システムからの通知を HTTP で受け取り、通話中の Discord VC に割り込んで読み上げる入口も持つ。

- **フレームワーク**: [Flue Framework](https://flueframework.com/) 2.x（TypeScript / Node.js）
- **LLM**: LLM プロキシ（LiteLLM ベースの OpenAI 互換プロキシ）経由。**API キー方式のモデルのみ使う**（OAuth 経由は k8s に載らないため不採用 → D-10）
- **音声**: 出力は VOICEVOX **CPU 版**（**独立した Deployment**。agent には接続情報だけを渡す）、入力は STT（さくらの AI Engine の Whisper、→ D-16）。伝送は Discord ボイスチャンネル
- **アバター**: ブラウザ上で three.js + `@pixiv/three-vrm` によりクライアントサイド描画
- **デプロイ**: 自宅 Kubernetes クラスタ（インフラ定義リポジトリ + ArgoCD GitOps）

先行実装が 2 つある。**新規に設計する前に必ず読むこと。**

- 先行実装リポジトリ — Flue で書かれた LINE 版パーソナルアシスタント。**エージェント構成・スキル自己改善ループ・永続化・デプロイ経路の流用元**
- `claude-plugins` マーケットプレイスの `discord-vc/` — Claude Code 用プラグイン。**Discord VC 参加・VOICEVOX 合成・HTTP 経由の通知読み上げの流用元だったが、実装は yachi8000 へ取り込み済み**（→ D-06 の差分表、D-22）。プラグイン v2.0.0 は yachi8000 の通知 API を叩くだけのクライアントで、Bot は持っていない

> **このリポジトリは public。** 個人を特定する情報・内部ホスト名・プライベート IP・ホストの絶対パスを書かない。他リポジトリを指すときは相対的な呼称を使う。

## 共通の開発方針

house rule は `dev:development-principles` スキルに集約されている。**本ファイルはそこからの差分のみを書く。** クリーンアーキテクチャ・フォールバック禁止・テスト方針・Docker/k8s 運用・Issue 起票基準・開発サイクルは、そちらを参照すること。

本ファイルとスキルが矛盾する場合、**本ファイルが優先する**。矛盾を見つけたら勝手にどちらかへ寄せず、ユーザーに提示する。

## 絶対ルール（このプロジェクト固有）

1. **Discord / Slack の非公式手段を使わない。** Discord Bot は公式 API で映像を送信できず、Slack Huddle には API が無い。selfbot・ヘッドレスブラウザ自動化・ユーザートークン利用は、動く実装が世に存在しても採用しない（ToS 違反かつグローバル CLAUDE.md の「迂回・ハック禁止」に抵触）。根拠は `docs/requirements/02-constraints.md`
2. **サーバサイドで 3D を描画しない。** 本番ホストはヘッドレス Linux。アバター描画はブラウザ（WebGL）に閉じる。サーバは状態とイベントを配信するだけ（GPU の有無に関わらず成立する方針。GPU 搭載状況自体は未確認 → Q-02）
3. **LLM に副作用を持たせない。** LLM には分類・要約・書き換え・判断のみをさせ、構造化された結果を受け取ってから決定的なコードが外部システムを操作する
4. **自動生成されたスキルを無審査で有効化しない。** 生成は自動でよいが、エージェントの応答に反映されるのは承認後に限る（→ F-40 系）
5. **アシスタントに発話させられる入口は必ず認証する。** 外部通知 API は到達性（localhost バインド等）を認証の代わりにしない。既存 `discord-vc` はそれで守っているが、k8s 上では成立しない（→ F-18）
6. **外部由来のテキストを指示として扱わない。** 通知本文・検索結果は非信頼データ。LLM へ渡す際にデータと指示が構造的に区別できる形にする（→ F-19）
7. **縮退は必ずログに出す。** フォールバック禁止の例外は「意図的な部分縮退」のみで、WARN 以上で記録されていることが条件（→ INV-7）
8. **静的設定とランタイム状態を同じ場所に置かない。** 人が決める設定（名前・既定の人格・VRM 参照・固定モード）と、プロセスが積み上げる状態（人格の変化・学習したスキル）は別の実体に持つ（→ INV-8, D-12）
9. **設定ファイルに書いてよいのは、人の操作を契機とする書き込みだけ。** 設定 UI のハンドラは書いてよい（利用者が押した結果だから）。**会話ロジック — エージェント・スキル・ツール・poller・停止処理・定期処理 — は書かない**（→ INV-9）

### 人格の組み立て方（混同しやすい）

人格は**静的設定（設定ファイル）とランタイム状態（DB の変化差分）の 2 つから合成する**。片方だけを見て実装しないこと。**正典は `docs/requirements/05-decisions.md` の D-12**（表はそちらにあり、ここには複製しない）。

応答時は「静的設定 + （固定モードでなければ）差分」を合成する。**固定モードは「差分を読まない」だけで実現する** — 差分の記録自体は止めない（OFF に戻せば元の続きから効く）。システムプロンプトの先頭に入れる「人格・口調を変更しない」指示は**補助であって強制ではない**（→ D-13 の既知の限界）。

### 読み上げ文面の扱いの違い（混同しやすい）

| 種別 | 文面 | 理由 |
|---|---|---|
| 外部通知 | LLM で自然文に書き換える。失敗時は決定的テンプレート + WARN ログ | 機械的な通知文を会話に馴染ませることに価値がある |
| リマインダー | 保存済みの title / description をそのまま読む。**言い換えさせない** | 利用者が書いた文言の正確な再現に価値がある |

### 外部通知 API（フェーズ 3）

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| `POST` | `/api/v1/notify` | Bearer（`NOTIFY_TOKENS`） | 通知本文（`{"text": "..."}`）を受理する。読み上げ完了は待たず `202` を返す |
| `GET` | `/api/v1/voice/status` | 同上 | VC 接続状況と `lastNotifyAt`（**受理**時刻）。チャンネル ID が乗るので認証必須 |
| `GET` | `/api/v1/health` | 不要 | 死活監視 |

**送信元はトークンから決まる。** リクエスト本文に名乗らせない（名乗れると送信元を騙れる）。`NOTIFY_TOKENS` は `送信元:トークン` のカンマ区切り。

`DEBUG_MODE=true` のときだけ `/debug/chat` `/debug/vc-join` `/debug/vc-leave` が生える。**認証が無い**ので `ENVIRONMENT=production` との併用は起動時に拒否される。

## ディレクトリ構成

```
agent/           Flue アプリ本体（TypeScript）
  src/
    domain/            モデル・値オブジェクト・port（interface）定義。外部依存なし
      ports/           application が使う interface。実装は infrastructure 側
    application/       ユースケース。port 越しにのみ外部を触る
    infrastructure/    port の実装（LLM / 埋め込み / pgvector / 設定ファイル / 人格差分 / 音声合成 / Discord 接続）
      discord/         Gateway の接続そのもの・VC 出力・テキスト配信
      voice/           VOICEVOX 互換エンジンのクライアント
    interfaces/        入口と表示整形（discord/ = メッセージ処理とスラッシュコマンド、http/ = 通知 API とデバッグ用ルート）
    agents/            Flue の `'use agent'` エージェント定義と 1 ターンの実行
    tools/             Flue `useTool` 定義。application のユースケースを呼ぶ薄い層
    skills/            スキルの永続化・動的マウント（フェーズ 4）
    config/            valibot による環境変数スキーマ
    observability/     ロガー
    composition-root.ts  infrastructure の具体実装を組み立てる場所
    app.ts             起動時の配線（setProvider / スキーマ準備 / ルート登録 / Discord 接続）
    db.ts              Flue の永続化アダプタ（会話履歴の SQLite）
  scripts/
    check-layering.mjs 依存方向の検査（`npm run lint` から実行）
  settings.example.yaml  静的設定のひな形（複製して SETTINGS_PATH の場所へ置く）
web/             アバター表示 + 設定 UI のフロントエンド（フェーズ 6。Vite + three.js + @pixiv/three-vrm）
compose.yaml     開発時の依存サービス（pgvector + 音声合成エンジン）
docs/
  requirements/  要件定義（正典）
```

**Flue の `agents/` `tools/` は層ではなくフレームワーク接触面**として扱う。ユースケースの実体は `application/` に置き、`tools/` はそれを呼ぶだけにする。合成ルートは `composition-root.ts`（何を組み立てるか）と `app.ts`（起動時に何を配線するか）に分かれている。

ランタイム状態（会話履歴 SQLite・設定ファイル）は `agent/data/`（gitignore）。k8s では PVC 上のパスを `FLUE_DB_PATH` / `SETTINGS_PATH` で渡す。

## 層の責務マッピング

**正典は `docs/requirements/04-architecture.md`。** ここには再掲しない（二重に持つと必ず片方だけ更新されて食い違う）。

要点だけ: 依存方向は CI で機械的に検査する。application → infrastructure の通常依存を検出したら落とすこと。目視レビューでは守られない。

## LLM プロバイダの設定

開発用の LLM プロキシ（LiteLLM、既定ポート 4000、OpenAI 互換 `/v1`）と、運用時はクラスタ上の LiteLLM を単一の入口にする（→ D-17）。

Flue には組み込みプロバイダのカタログがあるが、`app.ts` で `setProvider()` にカスタムプロバイダを登録すればカタログ外のモデルも使える。**先行実装で踏んだ「カタログ未収録の新モデルへ切り替えられない」制約は、この経路で回避する。**

```ts
// agent/src/app.ts（合成ルート）
import { setProvider } from '@flue/runtime';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

setProvider(createProvider({
  id: 'LLM プロキシ',
  auth: /* ProviderAuth。必須フィールド */,
  models: [{ id: '<model_list の model_name>', api: 'openai-completions', baseUrl: env.LLM_PROXY_BASE_URL }],
  api: openAICompletionsApi(),
}));
```

**検証済み**（先行実装リポジトリの `node_modules` にある `@flue/runtime` 2.0.3 / `@earendil-works/pi-ai` 0.83.0 の型定義を直接確認、2026-09-10）:

- `setProvider` は `@flue/runtime` の公開エントリから export されている
- `createProvider` は `@earendil-works/pi-ai` のルートから export されている
- **`openAICompletionsApi` はルートには無い。** `api/openai-completions.lazy` サブパスから import する（公式ガイドの例は import 元を示していない）
- **`CreateProviderOptions.auth` は必須。** 型定義のコメントいわく「every provider has auth semantics, even ambient/keyless ones」。省略できない

使えるモデル名は 開発用の LLM プロキシの `config/config.yaml` にある `model_list[].model_name` が正典。**記憶で書かず、その都度読むこと。**

## 開発コマンド

`agent/` 配下で実行する。先行実装と同じ構成に揃える。

```bash
npm run dev        # vite dev
npm run build      # 本番ビルド
npm start          # node dist/server.mjs
npm run typecheck  # tsc --noEmit
npm run lint       # Biome（lint + format チェック）
npm run lint:fix   # Biome の自動修正
npm test           # vitest run
```

TypeScript は strict（`noUncheckedIndexedAccess` を含む）。コマンドの実体は npm scripts（先行実装と同じ）。リポジトリ横断のタスクを足す必要が出たら `mise.toml` でラップする。**Makefile は使わない。**

`npm run lint` は Biome に加えて `scripts/check-layering.mjs` を走らせる。依存方向（domain → 何も / application → domain のみ / interfaces → infrastructure 禁止）はここで機械的に落とす。目視レビューでは守られない。

開発時の依存サービスはリポジトリルートの `compose.yaml`（`docker compose up -d`）。agent 本体は HMR を効かせたいので compose には入れず `npm run dev` で動かす。

## セットアップ

- **Discord Bot は yachi8000 専用に作る。** 既存の 2 つ（`discord-vc` プラグイン用 / `discord` プラグイン用）は流用しない。手順・必要な intents・scopes・権限は `docs/setup/discord-bot.md`
- **`MESSAGE_CONTENT`（特権インテント）は、まず OFF で試す。** DM と「Bot へのメンション」は特権インテント無しでも content が読める例外で、F-01 の応答方針（DM は常に応答 / チャンネルはメンション時のみ）はちょうどその範囲に収まる。**実機で content が空でないことを確認してから OFF で確定すること**

## 環境・秘密情報

- このマシンは SSH 経由のヘッドレス環境。`xdg-open` やブラウザ起動は無意味。HTML を確認させたい場合はファイルに出力してパスを伝える
- 認証情報は GNU pass で管理し、平文をコンテキスト・ログ・git に出さない（`dev:secrets-via-pass` スキル）
- `.env.example` のみコミットする。k8s 上では Sealed Secrets
- 環境変数は valibot スキーマで検証し、不正なら**起動時に落とす**
- **環境変数と設定ファイルの役割を混ぜない。** 環境変数は接続先・認証情報。設定ファイルは**ユーザー体験の定義**（名前・人格・口調・VRM・声）。設定ファイルは利用者ごとの内容なのでコミットしない
- **設定 UI は認証必須**（→ 絶対ルール 5）。無認証だと誰でも人格と声を書き換えられる

## 永続化

**正典は `docs/requirements/04-architecture.md` の「永続化するもの一覧」。** ここには要点だけ。

- **PVC 1 本に SQLite（会話履歴・スキル・人格差分・リマインダー）と設定ファイルと VRM を置く。** **長期記憶は専用 Postgres + pgvector**（`pgvector/pgvector:0.8.6-pg18`）で、別 Deployment + 専用 PVC（→ D-20）。**既存の共用 Postgres（EOL 済みの PG 12、他のアプリが相乗り）には触らない**
- **設定ファイルに ConfigMap を使わない。** 設定 UI が書き込むため（読み取り専用マウントで書けず、書けても再起動で戻る）
- **PVC の中身は ArgoCD の管理外。** git push では復元されない。**クラスタ再構築時は設定ファイルと VRM を手で置き直す。PVC はバックアップ対象**
- 音声バッファ・合成キャッシュは `emptyDir`（`sizeLimit` 付き）。**PVC には置かない**
- **会話履歴は Flue の自動圧縮で落ちていく。** 残したい事実は pgvector へ明示的に書き出さないと消える
- **長期記憶のテナント分離は列で行う**（`WHERE tenant_id = ?`）。インデックスにテナント列を含める

## デプロイ

インフラ定義リポジトリの ArgoCD GitOps に載せる。反映経路は git push のみで、`kubectl apply` / `helm install` の直接適用は禁止。

1. 本リポジトリの CI がイメージをビルド・push（`:latest` と `:<version>` の 2 タグ）
2. インフラ定義リポジトリへ `helm-charts/yachi8000/values.yaml` の `image.tag` 更新 PR を自動作成
3. PR マージ後、ArgoCD が自動同期
4. **起動ログのバージョンが更新されたことを必ず確認する**

インフラ定義リポジトリ側に必要なもの: `apps/yachi8000.yaml`（ArgoCD Application）、`apps/_secrets/yachi8000/`（Sealed Secret）、`helm-charts/yachi8000/`（**agent / 音声合成エンジン / 長期記憶 DB の 3 つの Deployment**）。

**手順の正典は `docs/setup/deploy.md`。** 設定ファイルを PVC に置く初回作業と、Pod 再起動のたびに VC から抜けることもそちらに書いてある。

**このリポジトリは public なので、CI のワークフローにレジストリのプロジェクト ID と GitOps リポジトリ名を書かない。** どちらもリポジトリシークレット（`IMAGE_REPOSITORY` / `GITOPS_REPO`）から読む。

### デプロイ上の制約

- **レプリカは 1、更新戦略は Recreate。** 同一トークンで Gateway 接続を 2 本張ること自体は**できる**（実測、→ Q-13）。問題は**両方が同じイベントを受け取る**ことで、RollingUpdate で新旧が同時に生きると 1 通のメッセージに 2 回返信する。VC 接続と再生キューが単一プロセスに閉じている点（INV-5）も同じ結論を指す
- **音声合成エンジンは独立した Deployment。サイドカーにしない。** agent には**接続情報（`VOICEVOX_URL`）だけ**を渡す。話者・話速・音高は設定ファイルの `voice` ブロック（F-60）で選ぶ。運用者がエンジン・話者を差し替えられることが要件（→ D-05）。コードにホスト名も既定の話者も埋め込まない
- **差し替え先は VOICEVOX 互換 API であること。** `/synthesis` だけでなく **`/audio_query` をリップシンクに使う**（F-21）。**起動時に契約を検証して落とす** — 合成だけ通ってリップシンクが黙って壊れるのが最悪
- **VOICEVOX は CPU 版。** 実測で RTF 0.14〜0.31（C-14）。**発話は文単位で分割して合成し、1 文目が出来次第再生を始める**（一括 914ms → 分割 551ms、C-15）。この分割は再生キューの内側に閉じ込める
- 音声バッファ・合成キャッシュは永続ボリュームに置かず `emptyDir`（`sizeLimit` 付き）を使う
