# CLAUDE.md

このファイルは、このリポジトリのコードを扱う際に Claude Code (claude.ai/code) にガイダンスを提供します。

## 開発ステータス

**実装フェーズ・未リリース。フェーズ 4 まで実装済みで、自宅 Kubernetes クラスタで稼働中（2026-09-11〜）。フェーズ 3.5・4 は 2026-09-12 にデプロイ済みだが、機能そのものは実機未確認。フェーズ 6（アバター）は設定 UI まで全部デプロイ済み（`version: 40c4439`）。**

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | Discord テキスト対話（F-01, F-02, F-04, F-05, F-30, F-32, F-60） | 実装済み・稼働中 |
| 2 | Discord 音声出力（F-11, F-12） | 実装済み・稼働中 |
| 3 | 外部通知（F-15〜F-19） | 実装済み・稼働中 |
| 3.5 | リマインダーと調べもの（F-31, F-35） | 実装済み・**デプロイ済み（実機未確認）** |
| 4 | スキル自己改善（F-40〜F-44, F-33, F-34） | 実装済み・**デプロイ済み（実機未確認）** |
| 4.5 | スレッドから Issue 起票（F-37） | 実装済み・**デプロイ済み（実機未確認）** |
| 6 | アバター（F-20〜F-25, F-61, F-62） | **デプロイ済み**（映す + 口が動く + ブラウザでも鳴る + 表情 + 身振り + 設定 UI）。身振りは素材（VRMA）が未配置で、置くまで出ない |
| 7 | 音声入力（F-13, F-14）+ カメラ（F-26） | **経路 B（ブラウザのマイク）の 1 段目とカメラをデプロイ済み**（`version: 575421b`）。手動のボタンで 1 発話を送り、**文字起こしはクラスタ内の faster-whisper**（→ D-48）。実機で端から端まで疎通済み。**常時聞き取り（VAD）は未着手。引き伸ばしは不要になった** |

**⚠ フェーズ 3.5・4 は載ってはいるが、まだ使われていない。** 起動（`version: f6cc2bd`）とポーラーの開始は確認済みだが、**リマインダーの着信・`/skill`・`/persona`・キュレーターの発火は誰も踏んでいない。** 最初に触ったときに壊れている可能性が一番高いのはそこ。

**通知の宛先指定（D-31）は 2026-09-18 にデプロイ済み（`version: 532b0f9`）で、実機で疎通確認も済んでいる。** `channel: "money"` で `#金` へ配信できること（`disposition: delivered-as-text`）と、設定に無い名前が 400 で弾かれることの両方を実際に叩いて確認した。クラスタ側の前提（PVC 上の `settings.yaml` の `notification.channels.money`、`NOTIFY_TOKENS` の `money-topic:`）も**反映済み**。呼ぶ側は別リポジトリの money-topic（`/home/yui/apps/money-topic`）。

クラスタ側の前提（`BRAVE_SEARCH_API_KEY` の Sealed Secret、`APP_DB_PATH`、PVC 上の `settings.yaml` の `reminderPollIntervalSeconds`）は**反映済み**。手順は `docs/setup/deploy.md`。

**⚠ フェーズ 6（アバター）は 2026-09-20 にデプロイ済み。PVC 上の VRM（`/data/avatar.vrm`）と `settings.yaml` の `avatar` 節も置いた。** **ブラウザで映ることは実機で確認済み**（2026-09-21）。**口が動くこと・音が鳴ることはまだ誰も見ていない**（口形と表情の重ね方は実機の VRM で `overrideMouth` を確かめて決め直した → D-41 の 2）。

**表情（F-24）と身振り（F-25）は 2026-09-21 にデプロイ済み**（`6b3dc2a` / `a1c231f`）。判断は Jev（型付きの判断だけを返すモデル）に頼む（→ D-41, D-42）。**`JEV_API_KEY` の Sealed Secret も反映済み**（**任意なので、無くても起動する** —— 素の顔のまま動き、起動ログに WARN が 1 行出るだけ）。**身振りだけは素材（VRMA）が PVC に無いので出ない** —— 無償で手に入る 7 種はこちらの語彙（頷く・首をかしげる・肩をすくめる・示す）とほとんど噛み合わず、入手先が決まっていない（→ Q-27）。

**Jev は実キーで疎通済み**（2026-09-21、6 例。表は D-41 の 4）。確認できたこと:

- **リクエストの形は通る。** 文面を `state` のオブジェクト（`{ 発話: … }`）で渡す形も、選択肢のキーを日本語で並べる形も受理された
- **確信度の山は 2 つに割れる。** 感情を選ぶときは 0.75〜1.00、感情の無い発話は `neutral` を 0.75。**間には何も落ちてこない**ので、閾値は空いている 0.6 に置いた
- **1 本目だけ 1212 ms、2 本目以降は 249〜568 ms。** 時間切れを 800 ms にしていたら「**再起動後の最初の発話だけ顔が動かない**」形で壊れていた（2 秒にした）
- **落ちることはある。** プローブの最中に数分間 503（`no healthy upstream`）を返していた。**止まっている間は素の顔 + WARN で読み上げは続く**

**ブラウザでアバターが映ることまでは実機で確認済み**（2026-09-21）。**まだ誰も見ていないのは「発話に合わせて顔が変わること」** —— 口形と食い合わないこと（→ D-41 の 2）も含めて、実機で見るまで未確認。

**設定 UI（F-61）は 2026-09-22 にデプロイ済み（`version: 40c4439`）。クラスタ側の前提は無い**（環境変数も設定ファイルの項目も足していない）。実機で確かめたのは 3 つ:

- `GET /api/v1/settings` が PVC 上の設定を版（mtime）付きで返す
- `GET /api/v1/settings/voices` がエンジンの声を返す（**ずんだもん・四国めたん等が実際に並ぶ**）
- `/settings.html` が 200 で配られる。**設定ファイルもそのディレクトリも書ける**（コンテナは root、ファイルは 0664）

**まだ誰も踏んでいないのは保存（`PUT`）。** 本番の設定を書き換えることになるので叩いていない —— **最初に押したときに壊れている可能性が一番高いのはそこ**（衝突検知・コメントの保全・話者の突き合わせ）。

**⚠ 音声入力（F-13 の経路 B）とカメラ（F-26）は 2026-09-22 にデプロイ済み（`version: 1c9a1b4`、WARN / ERROR ゼロ）。** 実機で確かめたのは 4 つ:

- `POST /api/v1/presence` が応答する（在席の入口）
- `POST /api/v1/mic/utterance` が **403** を返す（対応表がまだ無いので正しい振る舞い）
- 顔検出の wasm（323KB の JS）とモデル（230KB）が配られる
- `STT_MODEL` が Pod に入っている

**話者の対応表（`web.speakers`）は 2026-09-22 に PVC 上の `settings.yaml` へ置いた**（認証基盤の利用者名 → `discord-user-<id>`。→ D-45）。**実機で確認済み** —— 認証で通っている利用者名なら 200、対応表に無い名前は 403。`GET /api/v1/me` が `{ username, speakerId }` を返すので、**誰として扱われているかは画面（設定ページ）で確かめられる**（`version: 9e70c64`）。

**⚠ 操作のボタンは 2026-09-23 まで画面外にあった。** `#mic` と `#camera` に位置指定が無く、画面いっぱいの canvas の後ろへ流れていた（`body` が `overflow: hidden` なのでスクロールもできない）。**どの端末でも見えていなかった。** 固定配置をやめ、`body` を縦の flex にして canvas・表示・操作の帯を積む形に直した（`version: 9e70c64`）。**ボタンを足すときに `position: fixed` を書かないこと** —— 置き場所の取り合いになったのが元の原因。

**⚠ 文字起こしは無料枠を使い切って 429**（2026-09-23 に判明。→ Q-29）。**エンジンは落ちていない** —— さくらの `/chat/completions` は 200 / 0.66 秒で返り、`/audio/transcriptions` だけが `retry-after: 60` 付きの 429 を返す。**フリープランの音声認識は 1 ヶ月 50 リクエスト**（chat は 3,000）で、2026-09-22 の測定で使い切った。**超過後は「一切通らない」ではなく「数時間に 1 回だけ通る」**（実測）。

**「落ちている」に見えたのは LiteLLM の再試行のせい。** `num_retries: 2` が `retry-after: 60` を守るので、上流が 0.3 秒で返した 429 が **181.5 秒**に化ける。こちらの時間切れは 10 秒なので、**429 は一度も届かなかった**。**上流を疑う前に、プロキシを飛ばして直接叩くこと。** 再試行は 2026-09-23 に止めた（neko-services#72。モデル単位の `num_retries: 0`）。**実機で 429 が 1 秒以内に返ることを確認済み。**

**⚠ 文字起こしはローカルへ移した（→ D-48、2026-09-23 デプロイ済み、`version: 575421b`）。** `faster-whisper-small` をクラスタ内の CPU で回す（`yachi8000-stt` Deployment。LiteLLM の `local-whisper-small` 経由）。**2 秒の下限は消えた**（さくらの受け口の性質だった）ので、**Q-28 の引き伸ばしは作らない**。ノードに GPU は無い（→ C-06）。

**実機で端から端まで通した**（2026-09-23）。VOICEVOX で合成した「マイクのテストです。聞こえていますか。」を `POST /api/v1/mic/utterance` へ投げて **200 / 5.26 秒**、`transcript` は正しく、返事も生成された。内訳は**文字起こし 2.05〜2.12 秒**（プロキシ経由の実測。1 本目だけ 3.75 秒でモデル読み込みぶん）+ 会話のターン。

**デプロイは 2 段階に分けた。** agent は起動時に `STT_MODEL` の実在を `/model/info` で検証して落ちるので、**サーバを立てる PR（neko-services#73）と `sttModel` を切り替える PR（#74）を分ける**（同じ PR だと ArgoCD が両方を同時に動かし、agent が一時的に起動できない）。

**設定で効くのは 2 つだけ**（どちらも実測）: `WHISPER__COMPUTE_TYPE=int8`（既定は float32 に落ちて 11.5 秒 → 6.8 秒）と、**`WHISPER__CPU_THREADS` を `limits.cpu` と揃えること**（揃えないと cgroup に絞られて 1.48 秒 → 3.75 秒）。

**⚠ 無音は空で返るが、音が鳴っていれば幻聴が返る。** 3 秒の無音とピンクノイズは `""` だが、**純音には「ご視聴ありがとうございました」を返した**（`vad_filter` でも変わらない）。**押して喋らずに送ると、幻の発話が 1 ターンになる。**

**⚠ 文字起こしには 2 秒の下限がある**（実測 → D-16 の追記）。「ありがとう」「わかりました」は**空文字で返る**。いまは「聞き取れませんでした」と画面に出すだけで、**引き伸ばしはまだ入れていない**（→ Q-28 の決着は「引き伸ばして送る」だが、比べる途中でエンジンが落ちた → Q-29）。

**ページと `/api/v1/avatar/*`・`/api/v1/settings*`・`/api/v1/mic/*` の認証は ingress の forward auth で行う（→ D-37）。** 配線は GitOps リポジトリ側にあり、**アプリ側にはコードが 1 行も無い**。`/api/v1/notify`・`/api/v1/voice/status`・`/api/v1/health` だけは別 Ingress で素通しにしてある（Bearer で自分を守っているもの + 死活監視）。**ここに path を足すことは「インターネットから素通しで届く」という意味になる。**

**⚠ Issue 起票（F-37）は 2026-09-18 にデプロイ済み（`version: 4f13665`、起動ログで確認）。クラスタ側の前提は 2 つとも未反映。** どちらも入れるまで、スレッドで「Issue にして」と頼んでも失敗する:

- `GITHUB_TOKEN` の Sealed Secret（fine-grained PAT、対象リポジトリの `issues: write` のみ）。**任意の環境変数なので、無くても起動はする** —— 失敗するのは頼まれた瞬間だけで、起動ログには出ない
- PVC 上の `settings.yaml` の `issueTracker.repositories`（ArgoCD の管理外なので手で置く）。例: `"1478391009934180352": Im-neko/stocktrade`

要件の正典は引き続き `docs/requirements/`。実装は `agent/`。

**⚠ テナント分離は 2026-09-20 に廃止した（→ D-35）。同日 `9ab4e0c` 以降のイメージで**デプロイ済み**。** 人格・長期記憶・スキル・リマインダーは全体でひとつになり、代わりに**話者**（`SpeakerId`）が軸になった（→ F-05）。デプロイで起きたこと:

- **ランタイム状態 DB のテーブルが作り直された**（リマインダー・スキル・人格差分の中身は消えた。起動ログの `Dropped a tenant-scoped table` の WARN は `9ab4e0c` の Pod にだけ出る）
- **長期記憶（pgvector）は列を落としただけで、中身は残っている**
- **会話履歴（`FLUE_DB_PATH`）は無傷**（インスタンス ID の採番規則を変えていない）

互換性は意識しない。理想的な形に向けて自由に作り直してよい。互換のためだけのオプション・分岐を増やさないこと。常用に入った時点でこの節を更新する。

**稼働中なので、壊れると気付く。** 変更は CI（typecheck / lint / test）を通してから push すること。デプロイ後は**起動ログの `version` が新しいタグに変わったこと**を必ず確認する。

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

### フェーズ 3.5・4 で確認済みのこと

**2026-09-12 にデプロイ済み（`version: f6cc2bd`）。起動はするが、機能を踏んではいない。** 以下は「実際に確かめた」ものだけを並べる。

確かめたもの:

- **Brave Search API は実キーで疎通済み。** 要約に `<strong>` タグと `&#x27;` のような文字参照が混じることを実測で確認した。**解かずに渡すと「アンパサンド・シャープ…」が声になる**（→ D-27）。`&amp;` は最後に戻す（先に戻すと `&amp;#39;` が二重に解釈される）
- **キーなしの DuckDuckGo は使えない。** HTML 版は Cloudflare が **TLS 指紋**で弾いて HTTP 202 + 結果 0 件、公式 API は百科事典的要約だけで `Tokyo` すら空（実測）。指紋の偽装は検知回避にあたるので採らない（→ D-27）
- **2 つ目のエージェントは `@flue/vite` が自動で見つける。** ビルド出力に `__flueBindAgentModule(SkillCurator, …)` が入ることを確認した。手で登録する必要はない
- **`node:sqlite`（`DatabaseSync`）は Node 22.21 でフラグ無しに動く**（実験的機能の警告のみ）。Flue が内部で使っているものと同じで、**依存パッケージを 1 つも増やさずに済む**
- **本番で起動することは確認した。** ランタイム状態 DB が PVC 上の `/data/yachi.db` で開き、リマインダーのポーラーが 30 秒間隔で started になり、スラッシュコマンドの登録も通っている（WARN / ERROR ゼロ）
- **Artifact Registry へは `_json_key` でキーを直接渡す。** `google-github-actions/auth` の `token_format: access_token` は IAM Credentials API を呼ぶので、サービスアカウント自身に `serviceAccountTokenCreator` が要る。持っていないため 403 で落ちた（実測）

**まだ確かめていないもの（実機で最初に見るところ）**:

- `/skill` `/persona` スラッシュコマンドが実機で登録・応答するか（**権限ゲートは D-43 で廃止した。** 踏めるのは見える人）
- キュレーターが実際に返信後に発火し、まともなスキル候補を出すか。**応答レイテンシに影響しないか**
- リマインダーがポーリングで発火し、登録チャンネルと VC の両方へ届くか
- **繰り返しのリマインダー（毎日・毎週。→ D-29）が、鳴った後に次回へ進んで鳴り続けるか。** 列を後から足す経路（`ALTER TABLE`）は `9cfb5fa` のデプロイで通った（`Added a missing column` を実機ログで確認、2026-09-16）
- **リマインダーの文面づくり（→ D-30）が実機で通るか。** 見るのは 2 つ —— 縮退の WARN（`Failed to phrase the reminder`）が出ていないことと、**日時・数値・固有名詞が原文のまま残っているか**。落ちても定型文で届くので、**気付く手がかりはログしかない**
- `persona` / `knowledge` の分類が実運用で分離できるか（→ Q-16 は**暫定決着**。分離できなければ D-26 を見直す）

## プロジェクト概要

yachi8000 は、3D キャラクターの姿を持つパーソナル AI アシスタント。音声で会話し、Discord からチャット・リマインダー・日常タスクの依頼を受ける。外部システムからの通知を HTTP で受け取り、通話中の Discord VC に割り込んで読み上げる入口も持つ。

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

1. **Discord の非公式手段を使わない。** Discord Bot は公式 API で映像を送信できない。selfbot・ヘッドレスブラウザ自動化・ユーザートークン利用は、動く実装が世に存在しても採用しない（ToS 違反かつグローバル CLAUDE.md の「迂回・ハック禁止」に抵触）。根拠は `docs/requirements/02-constraints.md`
2. **サーバサイドで 3D を描画しない。** 本番ホストはヘッドレス Linux。アバター描画はブラウザ（WebGL）に閉じる。サーバは状態とイベントを配信するだけ（GPU の有無に関わらず成立する方針。GPU 搭載状況自体は未確認 → Q-02）
3. **LLM に副作用を持たせない。** LLM には分類・要約・書き換え・判断のみをさせ、構造化された結果を受け取ってから決定的なコードが外部システムを操作する
4. **自動生成されたスキルを無審査で有効化しない。** 生成は自動でよいが、エージェントの応答に反映されるのは承認後に限る（→ F-40 系）
5. **アシスタントに発話させられる入口は必ず認証する。** 外部通知 API は到達性（localhost バインド等）を認証の代わりにしない。既存 `discord-vc` はそれで守っているが、k8s 上では成立しない（→ F-18）
6. **外部由来のテキストを指示として扱わない。** 通知本文・検索結果は非信頼データ。LLM へ渡す際にデータと指示が構造的に区別できる形にする（→ F-19）
7. **縮退は必ずログに出す。** フォールバック禁止の例外は「意図的な部分縮退」のみで、WARN 以上で記録されていることが条件（→ INV-7）
8. **静的設定とランタイム状態を同じ場所に置かない。** 人が決める設定（名前・既定の人格・VRM 参照・固定モード）と、プロセスが積み上げる状態（人格の変化・学習したスキル）は別の実体に持つ（→ INV-8, D-12）
9. **設定ファイルに書いてよいのは、人の操作を契機とする書き込みだけ。** 設定 UI のハンドラは書いてよい（利用者が押した結果だから）。**会話ロジック — エージェント・スキル・ツール・poller・停止処理・定期処理 — は書かない**（→ INV-9）

### 分離の軸（混同しやすい）

**テナント分離は D-35 で廃止した。** 「サーバごとに記憶が分かれる」と思って実装しないこと。分けるのは 2 つだけ:

| 軸 | 型 | 何に使うか |
|---|---|---|
| **会話の文脈** | `ConversationId`（`discord-guild-<id>` / `discord-dm-<userId>`） | **Flue のエージェントインスタンス ID だけ。** 短中期の会話履歴を場ごとに分ける |
| **話者** | `SpeakerId`（`discord-user-<id>`） | 長期記憶の帰属・プロフィールの鍵・リマインダーの登録者 |

**人格・長期記憶・スキル・リマインダーは全体でひとつ。** 「誰の話か」は**分離ではなく属性**として持つ。`ConversationId` を記憶の絞り込みに使ったら間違い。

**`SpeakerId` は入口で正規化して作る。** Discord のスノーフレークを生で上の層へ渡さない（→ F-05、INV-10 と同じ規則）。

### 人格の組み立て方（混同しやすい）

人格は**静的設定（設定ファイル）とランタイム状態（DB の変化差分）の 2 つから合成する**。片方だけを見て実装しないこと。**正典は `docs/requirements/05-decisions.md` の D-12**（表はそちらにあり、ここには複製しない）。

応答時は「静的設定 + （固定モードでなければ）差分」を合成する。**固定モードは「差分を読まない」だけで実現する** — 差分の記録自体は止めない（OFF に戻せば元の続きから効く）。システムプロンプトの先頭に入れる「人格・口調を変更しない」指示は**補助であって強制ではない**（→ D-13 の既知の限界）。

### 出口の扱い（混同しやすい）

**Discord と Web は対等なインターフェース**（→ D-40）。片方がもう片方のおまけではない。

- **読み上げを止めてよいのは「受け取る出口がひとつも無いとき」だけ。** 「VC にいないから喋らない」は誤り
- **どの出口が受け取るかの判定は `domain/speech-audience.ts` に 1 つだけ置く。** 会話・通知・リマインダーの入口には持たせない（持たせると出口を足すたびに全部直すことになる）
- **出口として数えるのは「音を鳴らせると名乗ったタブ」だけ**（`?audio=1`）。見ているだけのタブを数えると、通知が無音へ向かって「喋った」ことになる
- **口形の配信は出口の選択と無関係。** 消音のタブでも口は動く（F-23）
- **DM の応答はブラウザへ出さない**（ページを開いている人が DM の相手とは限らない → Q-26）

### 読み上げ文面の扱いの違い（混同しやすい）

| 種別 | 文面 | 理由 |
|---|---|---|
| 外部通知 | LLM で自然文に書き換える。失敗時は決定的テンプレート + WARN ログ | 機械的な通知文を会話に馴染ませることに価値がある |
| リマインダー | **同じ形**。保存した title / description を素材に LLM が組み立て、失敗時は定型文 + WARN ログ | 毎回同じ定型文だと会話に馴染まない（→ **D-30 が D-08 を覆した**） |

**リマインダーで LLM に許すのは「言い方」だけ。** 日時・数値・固有名詞・URL は原文のまま残させる（プロンプトの規則）。**登録側で要約させない方針は変わっていない** —— 理由が「そのまま読まれるから」から「組み立ての素材だから」に変わっただけで、保存の時点で痩せると取り返せない。

**どちらの経路でも、読み上げる直前に URL を「リンク」へ置き換える**（→ D-28）。URL は音にしても意味が取れない。**テキスト配信側では消さない** —— チャンネルへ出す文面では URL は押せる情報。置換は `domain/speech.ts` の純関数で、発話の単一経路（INV-5）の入口でだけ適用する。

### 外部通知 API（フェーズ 3）

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| `POST` | `/api/v1/notify` | Bearer（`NOTIFY_TOKENS`） | 通知本文（`{"text": "...", "role": "..."}`。`role` は任意）を受理する。読み上げ完了は待たず `202` を返す |
| `GET` | `/api/v1/voice/status` | 同上 | VC 接続状況と `lastNotifyAt`（**受理**時刻）。チャンネル ID が乗るので認証必須 |
| `GET` | `/api/v1/health` | 不要 | 死活監視 |

**送信元はトークンから決まる。** リクエスト本文に名乗らせない（名乗れると送信元を騙れる）。`NOTIFY_TOKENS` は `送信元:トークン` のカンマ区切り。

**`role`（任意）は「送信元の中で何をしている人か」**（例: `CI を直している人`）。同じ送信元が並行して動いていると `おわりました` だけでは何が終わったのか分からないため（→ D-25）。**`role` は自己申告で検証しない。** 表示では `送信元（role）` の形にし、**トークン由来（騙れない）と本文由来（騙れる）を同じ見え方で混ぜない。**

`DEBUG_MODE=true` のときだけ `/debug/chat` `/debug/vc-join` `/debug/vc-leave` が生える。**認証が無い**ので `ENVIRONMENT=production` との併用は起動時に拒否される。

## ディレクトリ構成

```
agent/           Flue アプリ本体（TypeScript）
  src/
    domain/            モデル・値オブジェクト・port（interface）定義。外部依存なし
      ports/           application が使う interface。実装は infrastructure 側
    application/       ユースケース。port 越しにのみ外部を触る
    infrastructure/    port の実装
      db/              ランタイム状態の SQLite（リマインダー・スキル・人格差分・話者プロフィール。Flue の会話履歴 DB とは別ファイル → D-24）
      discord/         Gateway の接続そのもの・VC 出力・テキスト配信
      llm/             会話・通知書き換えの LLM 呼び出し
      memory/          長期記憶（pgvector）
      persona/ person/ reminder/ skill/  上記 SQLite 上の各ストア
      search/          Brave Search API のクライアント（→ D-27）
      stt/             文字起こし（F-13）。LLM プロキシ経由の Whisper（→ D-16）
      reaction/        Jev（型付きの判断モデル）で表情と身振りを判断する（→ D-41, D-42）
      settings/        設定ファイルの読み書き
      voice/           VOICEVOX 互換エンジンのクライアント
    interfaces/        入口と表示整形（discord/ = メッセージ処理とスラッシュコマンド、http/ = 通知 API とデバッグ用ルート）
    agents/            Flue の `'use agent'` エージェント定義と 1 ターンの実行
      yachi.agent.ts     会話する本体
      curator.agent.ts   スキル候補を出すキュレーター（返信確定後に fire-and-forget → F-40）
    tools/             Flue `useTool` 定義。application のユースケースを呼ぶ薄い層
    config/            valibot による環境変数スキーマ
    observability/     ロガー
    composition-root.ts  infrastructure の具体実装を組み立てる場所
    app.ts             起動時の配線（setProvider / スキーマ準備 / ルート登録 / Discord 接続）
    db.ts              Flue の永続化アダプタ（会話履歴の SQLite）
  scripts/
    check-layering.mjs 依存方向の検査（`npm run lint` から実行）
  settings.example.yaml  静的設定のひな形（複製して SETTINGS_PATH の場所へ置く）
web/             アバター表示 + 設定 UI のフロントエンド（フェーズ 6。Vite + three.js + @pixiv/three-vrm）
  src/
    api.ts           agent の /api/v1/avatar/* を叩く。**既定値でごまかさない**（取れなければ落とす）。SSE の購読もここ
    stage.ts         three.js の土台。VRM の読み込み・破棄・表情・カメラ・口形（F-21）
    pose.ts          待機の姿勢と細かい動き（呼吸・まばたき）。**T ポーズのまま立たせない**（F-20）
    gesture.ts       身振りの再生（F-25）。VRMA から**ボーンの回転だけ**取る（→ D-42 の 4）
    audio.ts         読み上げをブラウザでも鳴らす（F-23）。**押されるまで鳴らない**
    mic.ts           マイクから 1 発話を録る（F-13 の経路 B、→ D-47）
    presence.ts      カメラの前に人がいるかを見る（F-26、→ D-46）。**映像は出さない**
    main.ts          canvas・ボタン・状態表示の配線
    settings-api.ts  agent の /api/v1/settings* を叩く。**既定値でごまかさない**
    settings-main.ts 設定フォームの配線（F-61）。**版を持ち回って衝突を見る**
  index.html       アバターのページ
  settings.html    設定のページ（**別のページ。VRM を読まない** → D-44 の 7）
  public/models/   顔検出のモデル（230KB、コミットする）
  scripts/         顔検出の wasm を node_modules から複製する（11MB × 2、コミットしない）
  vite.config.ts   dev は 5174。/api だけ agent（5173）へ回す。ページは 2 枚
compose.yaml     開発時の依存サービス（pgvector + 音声合成エンジン）
docs/
  requirements/  要件定義（正典）
```

**Flue の `agents/` `tools/` は層ではなくフレームワーク接触面**として扱う。ユースケースの実体は `application/` に置き、`tools/` はそれを呼ぶだけにする。合成ルートは `composition-root.ts`（何を組み立てるか）と `app.ts`（起動時に何を配線するか）に分かれている。

ランタイム状態（会話履歴 SQLite・ランタイム状態 SQLite・設定ファイル）は `agent/data/`（gitignore）。k8s では PVC 上のパスを `FLUE_DB_PATH` / **`APP_DB_PATH`** / `SETTINGS_PATH` で渡す。**`APP_DB_PATH` を渡し忘れると、リマインダー・スキル・人格差分・話者プロフィールが Pod 再起動ごとに黙って消える**（会話は普通に続くので気付きにくい → D-24）。

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

**`web/` は別プロジェクト**（別の `package.json` / `node_modules` / Biome 設定）。CI も別ジョブで、`agent/` の変更では走らない。

```bash
cd web
npm run dev        # 5174。/api は agent（5173）へ proxy する
npm run build      # dist/ を作る。本番は agent がこれを配る（WEB_DIST_PATH）
npm run typecheck  # tsc --noEmit
npm run lint       # Biome
```

**three.js まわりは型が通ってもバンドルで落ちることがある**ので、CI では `build` まで通す。**dev サーバで映っても本番で映るとは限らない** —— 本番は agent が静的配信する別経路。確認は `npm run build` の成果物で行う。アバターの置き方は `docs/setup/avatar.md`。

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

- **PVC 1 本に SQLite 2 本（`FLUE_DB_PATH` = 会話履歴 / `APP_DB_PATH` = スキル・人格差分・リマインダー。→ D-24）と設定ファイルと VRM を置く。** **長期記憶は専用 Postgres + pgvector**（`pgvector/pgvector:0.8.6-pg18`）で、別 Deployment + 専用 PVC（→ D-20）。**既存の共用 Postgres（EOL 済みの PG 12、他のアプリが相乗り）には触らない**
- **設定ファイルに ConfigMap を使わない。** 設定 UI が書き込むため（読み取り専用マウントで書けず、書けても再起動で戻る）
- **PVC の中身は ArgoCD の管理外。** git push では復元されない。**クラスタ再構築時は設定ファイルと VRM を手で置き直す。PVC はバックアップ対象**
- 音声バッファ・合成キャッシュは `emptyDir`（`sizeLimit` 付き）。**PVC には置かない**
- **会話履歴は Flue の自動圧縮で落ちていく。** 残したい事実は pgvector へ明示的に書き出さないと消える
- **長期記憶はひとつの空間に持つ**（→ D-35）。テナント分離のための列は置かない。代わりに `speaker_id` で「誰の話か」を持つ（→ F-05）

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
