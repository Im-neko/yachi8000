# アバター（VRM）の用意

アバターの表示（F-20, F-62）に要るのは **VRM ファイル 1 つ**と、設定ファイルの `avatar` 節だけ。
**この節は省ける** —— 書かなければアバターのページが「設定されていません」と言うだけで、会話は普通に動く。

描画はすべてブラウザで行う（INV-2, D-02）。サーバは VRM と表示設定を返すだけで、three.js はフロントエンド（`web/`）にしか無い。

## 置き場所

**VRM は設定ファイルと同じ場所に置く**（→ D-36 の 2）。

| | 設定ファイル | VRM |
|---|---|---|
| 開発 | `agent/data/settings.yaml` | `agent/data/avatar.vrm` |
| 本番 | PVC 上の `/data/settings.yaml` | PVC 上の `/data/avatar.vrm` |

どちらも **git にはコミットしない**（`agent/data/` は gitignore）。本番の PVC は **ArgoCD の管理外**なので、クラスタを作り直したら**設定ファイルと一緒に手で置き直す**（`deploy.md` の「設定ファイルを PVC に置く」と同じ作業）。

`vrmPath` に書いたパスしか読まない。**リクエストからパスを受け取らない**ので、表示のために開けた口がファイルシステムの覗き穴にはならない。

## 設定

```yaml
avatar:
  vrmPath: ./data/avatar.vrm
  # 待機時の表情。**VRM 1.0 のプリセット名しか使えない**（→ D-36 の 1）。
  # neutral / happy / angry / sad / relaxed / surprised のいずれか。
  idleExpression: neutral
  camera:
    targetHeight: 1.3   # 注視点の高さ（m）。顔を見たいなら目の高さ
    distance: 1.5       # 注視点からの距離（m）。小さくすると寄る
```

**モデル固有の blendshape 名（`Fcl_ALL_Joy` のような）は受け付けない。** 設定の検証で落ちる ——
名前を通してしまうと、モデルを差し替えた瞬間に表情だけが黙って効かなくなる。

`targetHeight` / `distance` はモデルの身長に合わせて決める。合っていないと画面の外に立つ。

## VRM を用意する

普段使うモデルは VRoid Studio などで作る。**VRM 1.0 で書き出すこと** ——
0.x も読めるが（前後の向きだけ自動で直る）、表情のプリセットが揃っているとは限らない。

### 動作確認用のサンプル

手元にモデルが無いうちは、three-vrm のリポジトリが持っているサンプルで通しを確認できる。
**コミットを固定して取る**（`main` を指すと中身が変わる）。

```bash
curl -L -o agent/data/avatar.vrm \
  https://raw.githubusercontent.com/pixiv/three-vrm/5a3242b66124386c32b085c6693d9059040e72e5/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm

echo '12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2  agent/data/avatar.vrm' | sha256sum -c
```

ファイル自身が持つライセンス情報（`VRMC_vrm.meta`。**推測ではなく、ファイルから読んだもの**）:

| 項目 | 値 |
|---|---|
| `authors` / `copyrightInformation` | pixiv Inc. / (c) 2022 pixiv Inc. |
| `avatarPermission` | `everyone` |
| `allowRedistribution` / `modification` | `true` / `allowModificationRedistribution` |
| `creditNotation` | `unnecessary` |
| `licenseUrl` | https://vrm.dev/licenses/1.0/ |

**それでもリポジトリにはコミットしない**（→ F-62, D-36 の 3）。**再配布は許されているので、理由は容量のほう** —— public リポジトリに 10.7 MB のバイナリを置かない。

このモデルは身長が 1.5m ほどなので、顔を見るなら `targetHeight: 1.25` / `distance: 1.2` あたりから始める。

## 開発時に動かす

dev サーバは 2 つ立てる。**フロントエンドは別ビルド**（→ D-36 の 5）で、API だけ agent へ回している。

```bash
cd agent && npm run dev     # 5173。API（/api/v1/avatar/*）はこちら
cd web   && npm run dev     # 5174。ブラウザで開くのはこちら
```

確認するのは 2 本:

```bash
curl -s http://localhost:5173/api/v1/avatar/config    # 表情とカメラ
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
  http://localhost:5173/api/v1/avatar/model           # VRM 本体
```

`404` のときは本文が理由を言う。**「設定されていません」と「置かれていません」は別物** ——
前者は設定ファイルに `avatar` を書く、後者は VRM を置く。

**dev サーバで通っても本番で通るとは限らない。** 本番は agent が `web/dist` を静的に配信する経路で、
dev サーバの proxy とは別物。最終確認は `cd web && npm run build` した成果物で行う。

## 本番で配信する

`web/` のビルド成果物は Dockerfile の中で作られ、agent が同一オリジンで配る（`WEB_DIST_PATH`、既定 `./web`）。
**成果物が無くても起動は止めない** —— アバターのページが出ないだけで、WARN が 1 行出る（INV-7）。

```
{"level":40,"path":"./web","msg":"No web frontend build found — the avatar page will not be served"}
```

**このページに認証は無い**（→ D-37）。守るのは ingress 側で、アプリには認証のコードを入れない。
**通知 API（F-18）とは別物** —— あちらは「発話させられる入口」なので、自前の Bearer トークンを持ち続ける。
