# デプロイ手順（Kubernetes）

自宅 Kubernetes クラスタへ ArgoCD GitOps で載せる。**反映経路は git push のみ**で、`kubectl apply` / `helm install` の直接適用は禁止。

インフラ定義は別リポジトリ（ArgoCD が見る GitOps リポジトリ）にあり、本リポジトリは**イメージを push して、そちらへイメージタグ更新 PR を出すだけ**。

## 構成

3 つの Deployment に分かれる。**1 つの Pod に同居させない。**

| Deployment | 役割 | 備考 |
|---|---|---|
| agent | 本体 | **レプリカ 1・`Recreate` 固定**。Gateway 接続と再生キューが単一プロセス（INV-5） |
| voicevox | 音声合成 | 運用者が差し替えられることが要件（D-05）。タグは**必ず固定**する |
| memory-db | 長期記憶（pgvector） | 専用インスタンス。共用 Postgres には相乗りしない（D-20） |

agent が受け取るのは接続情報だけ:

| 環境変数 | 値の出どころ |
|---|---|
| `LLM_PROXY_BASE_URL` / `LLM_MODEL` | チャートの values |
| `VOICEVOX_URL` | 同じチャートが作る voicevox Service の DNS 名 |
| `FLUE_DB_PATH` / `SETTINGS_PATH` | PVC 上のパス（`/data/`） |
| `DISCORD_BOT_TOKEN` / `LLM_PROXY_API_KEY` / `NOTIFY_TOKENS` / `MEMORY_DATABASE_URL` | Sealed Secret |

**話者 ID・話速・音高は環境変数に入れない。** 設定ファイル（`/data/settings.yaml`）側（F-60）。

## イメージのビルドと反映

1. `main` へ push すると CI（`.github/workflows/build-and-deploy.yml`）がイメージをビルドして `:<短い SHA>` と `:latest` の 2 タグで push する
2. 続けて GitOps リポジトリへ `image.tag` 更新 PR が自動で立つ
3. PR をマージすると ArgoCD が同期する
4. **起動ログの `version` が新しいタグに変わったことを必ず確認する。** 変わっていなければデプロイは失敗している

```
{"level":30,"version":"<タグ>","environment":"production","msg":"yachi8000 agent started"}
```

CI に要るリポジトリシークレット:

| シークレット | 用途 |
|---|---|
| `GOOGLE_CREDENTIALS` | コンテナレジストリへの push |
| `IMAGE_REPOSITORY` | イメージの完全なパス |
| `GITOPS_REPO` | GitOps リポジトリの `<owner>/<name>` |
| `GITOPS_DEPLOY_KEY` | GitOps リポジトリへの push（deploy key の秘密鍵） |
| `GITOPS_PR_TOKEN` | PR 作成用の PAT |

**レジストリのパスと GitOps リポジトリ名も値ごとシークレットに置く。** このリポジトリは public なので、ワークフローに直接書かない。

## 初回だけ手で要ること

### 1. 設定ファイルを PVC に置く

`SETTINGS_PATH` のファイルが無いと**起動時に落ちる**（フォールバック禁止。既定の人格を勝手に作らない）。**PVC の中身は ArgoCD の管理外**なので、git push では置かれない。

agent Pod が立つ前に置く必要があるため、PVC を単体でマウントする一時 Pod を使う。**置くのは `settings.example.yaml` ではなく、名前・人格・声を書いた実物**（開発時は `agent/data/settings.yaml`。gitignore されている）:

```bash
kubectl -n yachi8000 run settings-seed --restart=Never --image=busybox:1.37 \
  --overrides='{"spec":{"containers":[{"name":"seed","image":"busybox:1.37","command":["sleep","600"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"yachi8000-data"}}]}}'
kubectl -n yachi8000 wait --for=condition=Ready pod/settings-seed --timeout=120s
kubectl -n yachi8000 cp <手元の settings.yaml> settings-seed:/data/settings.yaml
kubectl -n yachi8000 delete pod settings-seed
```

VRM を置くのも同じ手順（フェーズ 6）。

> **PVC はバックアップ対象。** クラスタを作り直したら、設定ファイルと VRM は手で置き直す。

### 2. Discord 側の招待

Bot を対象サーバへ招待しておく（`docs/setup/discord-bot.md`）。スラッシュコマンドは起動時にギルドへ自動登録される。

### 3. ボイスチャンネルへの参加

**Pod が再起動するたびに VC からは抜ける。** 再参加は `/vc-join` を実行するまで行われないので、デプロイのたびに実行が要る。参加していない間、通知は設定に従ってテキスト配信されるか破棄される（どちらもログに残る）。

**永続状態からの自動再参加は実装しない**（2026-09-11 決定）。利用者が常に VC にいるわけではないため、
再起動のたびに勝手に入り直すと、誰もいない VC に居座ることになる。入るタイミングは利用者が決める。

## 通知 API を外から叩く

Ingress で公開するため、**認証は到達性ではなくトークンで行う**（絶対ルール 5、F-18）。

```bash
curl -X POST https://<ホスト>/api/v1/notify \
  -H "Authorization: Bearer $YACHI8000_NOTIFY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"ビルドが通りました"}'
```

送信元はトークンから決まる。送信元を増やすときは `NOTIFY_TOKENS` に `送信元:トークン` を足して Sealed Secret を作り直す。**トークンを本文に書かせない。**

`DEBUG_MODE=true` は `/debug/*` を無認証で生やすので、**公開する環境では絶対に有効にしない**（`ENVIRONMENT=production` との併用は起動時に拒否される）。

## ローカル開発との併用

**同じ Bot トークンで Gateway 接続を 2 本張ると、1 通のメッセージに 2 回返信する。** クラスタ上で動かしている間にローカルで `npm run dev` する場合は、**開発用に別の Discord アプリを作る**こと。
