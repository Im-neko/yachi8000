# 02. 前提と制約

**各項目に「確認済み」か「類推」かを明記する。** 確認済みには出所（URL / 読んだファイルのパス）を添える。類推は、実装着手前に確認して本文を更新すること。

調査日: 2026-09-10

---

## 外部サービスの制約

### C-01. Discord Bot は映像を送信できない（音声のみ）

**確認済み** — [Discord 公式サポートフォーラムの機能要望](https://support.discord.com/hc/en-us/community/posts/360063353611-Suggestion-An-Ability-for-Bots-to-stream-videos-via-VoiceChannels) / [Discord-RE/discord-video-stream](https://github.com/Discord-RE/Discord-video-stream)

公式 Bot API はボイスチャンネルへの音声送信のみをサポートし、カメラ映像・画面共有は送信できない。映像送信を実現している OSS は例外なく **selfbot（ユーザーアカウント自動化）** で、Discord ToS 違反にあたる。

**この制約の帰結**: 「Discord でビデオ通話」は選択肢から外れる。アバター映像は自前の Web ページで配信する（→ D-02）。

**採用してはならない回避策**: selfbot ライブラリ、ユーザートークンでの音声/映像送信、ヘッドレスブラウザで Discord クライアントを自動操作する方式。グローバル CLAUDE.md の「迂回・ハック禁止」に抵触する。

### C-02. Slack Huddle には API が無く、サードパーティ Bot の参加自体がブロックされている

**確認済み** — [Recall.ai: Slack Huddles API](https://www.recall.ai/product/slack-huddles-api) / [Shadow: Best AI Meeting Assistants for Slack Huddles 2026](https://www.shadow.do/blog/best-ai-meeting-assistants-for-slack-huddles-2026)

Slack は Huddle の音声・トランスクリプトを API として公開しておらず、Zoom / Google Meet と異なり meeting bot の参加をブロックしている。市販の記録ツールはすべて**デバイス側の音声キャプチャ**か headless Chrome の自動化で実現している。

**この制約の帰結**: 当初は「Slack 連携をテキストに限定する」根拠だったが、**2026-09-20 に Slack 連携そのものを取り下げた**（→ D-34）ため、現在この制約は計画に影響しない。事実として残す（Slack を再検討するときに読み直す）。

---

## フレームワーク・基盤の制約

### C-03. Flue はカスタム OpenAI 互換プロバイダを登録できる

**確認済み** — [Flue: Models & Providers ガイド](https://flueframework.com/docs/guide/models/)

`useModel('provider-id/model-id')` は既定では組み込みプロバイダのカタログを引くが、`app.ts` で `setProvider(createProvider({ id, models: [{ api: 'openai-completions', baseUrl }], api: openAICompletionsApi() }))` を呼べば、カタログ外の任意のエンドポイントを登録できる。

**この制約の帰結**: 先行実装が踏んだ「`@flue/runtime` のモデルカタログ未収録の新モデルへ切り替えられない」問題（出所: 先行実装リポジトリの `CLAUDE.md`）は、本プロジェクトでは**設計段階で回避できる**（→ D-03）。

### C-04. LLM プロキシは LiteLLM ベースの OpenAI 互換プロキシ（port 4000）

**確認済み** — 開発用の LLM プロキシの `compose.yaml`, `config/config.yaml`, `config/ccproxy.yaml`

`config.yaml` の `model_list[].model_name` が利用可能なモデル名の正典。プロバイダごとに `api_base` / `api_key` を持ち、Prometheus コールバックが有効。`default_model_passthrough: true`。

**利用可能なモデル名は記憶で書かず、その都度 `config.yaml` を読むこと。**

### C-05. LLM プロキシは Anthropic OAuth トークンをホストのファイルから読んでいる

**確認済み** — 開発用の LLM プロキシの `compose.yaml` にある Claude 認証情報ファイルの bind mount、および `ccproxy.yaml` の `oat_sources.anthropic`

現状の LLM プロキシはホストのファイルをマウントする前提で組まれており、**この構成のままでは Kubernetes 上に持ち上げられない**。yachi8000 を k8s にデプロイする際、LLM プロキシをどこでどう動かすかは未決（→ Q-01）。

### C-06. 本番ホストはヘッドレス Linux。GPU の有無は未確認

**一部確認済み** — ヘッドレス SSH 環境であることはグローバル CLAUDE.md に明記。**GPU の有無・自宅 k8s ノードの GPU 搭載状況は未確認（→ Q-02）**

**この制約の帰結**: 3D 描画をサーバサイドで行う設計（ヘッドレスレンダリング → 映像配信）は採らない。アバターはブラウザの WebGL に閉じる（→ D-02）。ローカル STT にモデルを載せるかは GPU の有無に依存する（→ Q-02）。

---

## 先行実装から引き継ぐ前提

### C-07. 先行実装のスキル自己改善ループは「生成は自動・有効化は承認制」

**確認済み** — 先行実装リポジトリの `CLAUDE.md`、`flue-app/src/agents/skill-curator.agent.ts`、`flue-app/src/skills/`

- `SkillCurator` はメインエージェントとは別に登録され、返信確定後に **fire-and-forget で dispatch** される。会話履歴・応答レイテンシに影響しない
- インスタンス ID は `skill-curator:<tenantId>` と明示的に prefix し、メインエージェントと確実に別アドレスにしている
- 候補は `propose_skill` で pending として記録され、`approve_skill` / `reject_skill` を経た approved のみが `defineSkill` + `useSkill` で動的マウントされる
- 承認は次ターン以降に効く（承認したその場の返信には反映されない）

**この構造をそのまま採用する。** 特に fire-and-forget と instance ID prefix は、実装で踏まれた設計判断とみなす。

### C-08. Discord VC への VOICEVOX 音声「送信」は実証済み

**確認済み** — `claude-plugins` の `discord-vc/`（`bot/` に discord.js + `@discordjs/voice` 実装、README に VOICEVOX 連携手順）

既存の `discord-vc` プラグインが、Discord VC へ参加して VOICEVOX 合成音声を再生する部分を動作実績のある形で持っている。**送信側は先行実装として流用できる。**

### C-09. Discord の音声受信は「非公式だが正規に動く」。必要なパッケージは導入済み

**確認済み** — `claude-plugins` の `discord-vc/bot/node_modules` を実見（2026-09-11）。

- `@discordjs/voice` **0.19.2** が `VoiceReceiver` / `AudioReceiveStream` / `EndBehaviorType` / `SSRCMap` を export
- `@discordjs/opus` 0.9.0（ネイティブ Opus デコーダ）、`prism-media` 1.3.5、`sodium-native` 4.3.3 も導入済み
- **話者分離は `VoiceReceiver.ssrcMap`（SSRC → Discord ユーザー ID）で標準提供される**

**重要な但し書き**（README 原文）:

> Send and receive\* audio in Discord voice-based channels
> \*_Audio receive is not documented by Discord so stable support is not guaranteed_

**Discord が公式にドキュメント化していないが、bot トークンで正規に動く。** selfbot を要する映像送信（C-01）とは性質が異なり、**INV-1 には抵触しない。** ただし仕様変更で壊れる可能性は残るため、B（Web のマイク入力）を並行して持つ（→ D-19）。

**未検証（類推）**: 発話区間の切り出し品質。`EndBehaviorType.AfterSilence` が話している最中に切れる不具合の報告がある（[discord.js#8105](https://github.com/discordjs/discord.js/issues/8105)）。**本環境での実測はまだ無い**（→ Q-03）。

### C-10. Flue に Discord アダプタは無い。Discord 連携は全て自前実装になる

**確認済み** — `@flue/runtime` 2.0.3 の型定義（`dist/*.d.mts`）を全文検索し、`discord` に一致する識別子・型・関数は**ゼロ**（2026-09-10 実施）。

代わりに Flue が提供するのは汎用の HTTP ルーティングで、`createChannelRouter(routes)` が Hono の `Handler` を受けて `Hono` インスタンスを返す。**Discord Gateway・VC・スラッシュコマンド、および通知 API のエンドポイントは、いずれも infrastructure / interfaces 層に自前で実装する。**

**この確認により Q-04 は解決済み**（→ D-09）。

### C-13. Flue のプロバイダ登録 API の正確な形

**確認済み** — 先行実装リポジトリの `node_modules` にある `@flue/runtime` 2.0.3 / `@earendil-works/pi-ai` 0.83.0 の型定義を直接確認（2026-09-10）。

- `setProvider` は `@flue/runtime` の公開エントリから export されている
- `createProvider` は `@earendil-works/pi-ai` のルートから export されている
- **`openAICompletionsApi` はルートには無い。** `@earendil-works/pi-ai/api/openai-completions.lazy` から import する。**公式ガイドのサンプルは import 元を示していないため、そのまま写すと通らない**
- **`CreateProviderOptions.auth` は必須。** 型定義のコメントいわく「every provider has auth semantics, even ambient/keyless ones」

**注意**: これは 先行実装が現在インストールしているバージョンでの事実。yachi8000 が別バージョンを入れる場合は再確認すること。

---

## 運用上の制約

### C-11. 反映経路は git push のみ

**確認済み** — インフラ定義リポジトリの `CLAUDE.md`

自宅 k8s は ArgoCD による GitOps。`kubectl apply` / `helm install` の直接適用は原則禁止。master は GitHub Ruleset で保護され、直接 push 不可・PR 必須・「CI Gate」ステータスチェック必須。

### C-12. 一時データ・キャッシュに永続ボリュームを使わない

**確認済み** — `dev:development-principles`

thin provisioning のブロックが解放されず実使用量と乖離して肥大する。音声バッファ・合成済み音声のキャッシュは `emptyDir`（`sizeLimit` 付き）に置く。SQLite の会話履歴・記憶は永続ボリューム。


---

## 実測データ

### C-14. VOICEVOX は CPU で実用に足りる（実測）

**確認済み** — 開発機で VOICEVOX Engine 0.25.1（CPU 版イメージ `voicevox/voicevox_engine`、speaker=3）を実測（2026-09-10）。計測機は 16 コア / 32 スレッドの x86_64。

| 入力 | audio_query | synthesis | 合計 | 生成された音声長 | RTF |
|---|---|---|---|---|---|
| 7 文字 | 33ms | 333ms | 366ms | 1.39s | 0.26 |
| 35 文字（通知文相当） | 186ms | 947ms | 1133ms | 5.41s | 0.21 |
| 45 文字 | 224ms | 1292ms | 1516ms | 7.53s | 0.20 |
| 122 文字 | 128ms | 2798ms | 2926ms | 20.19s | 0.14 |

**RTF（実時間比）は 0.14〜0.31 で、実時間の 3〜7 倍速で合成できている。** 同時 2 リクエスト（会話応答と通知が重なる想定）でも総経過 1082ms で、直列化による破綻は見られなかった。

**結論: GPU 版イメージは不要。CPU 版で確定する**（→ D-11）。GPU の判断が残るのは STT だけ（→ Q-02）。

**注意（類推）**: 上記は**開発機の CPU での実測**であり、自宅 k8s ノードの CPU は別。**ノードのコア数が大きく劣る場合は再計測すること。** RTF に 3〜7 倍の余裕があるため多少の性能差は吸収できるが、余裕の量までは保証しない。

### C-15. 文分割で初音レイテンシが約 4 割縮む（実測）

**確認済み** — 同上の環境で計測（2026-09-10）。

35 文字の通知文を合成した場合:

- 一括合成: **最初の音が出るまで 914ms**
- 2 文に分割し、1 文目を合成→再生開始しながら 2 文目を合成: **最初の音が出るまで 551ms**（全文完了は 990ms でほぼ同じ）

**実運用で効くのは合計時間ではなく「最初の音が出るまで」**。F-14 のレイテンシ目標は、文単位で分割合成し、1 文目が出来次第再生を始める設計を前提にする。

### C-16. `/cancellable_synthesis` は既定で無効

**確認済み** — 実行中の 0.25.1 に対して呼び出したところ HTTP 404、`{"detail":"実験的機能はデフォルトで無効になっています。使用するには引数を指定してください。"}`。

割り込み時に合成中のリクエストを打ち切りたい場合（→ Q-05）、**Engine の起動引数で明示的に有効化する必要がある**。compose / Helm の起動引数に入れるかは Q-05 と併せて決める。
