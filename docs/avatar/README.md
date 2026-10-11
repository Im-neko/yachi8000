# アバターのモデリング（素材と手順）

yachi8000 のアバター（VRM）を、1 枚のキャラクターイラストから作るための素材と手順。
VRM を**置く**側の手順は `docs/setup/avatar.md`。ここは**作る**側。

## 素材

`docs/avatar/character-sheet/`（**画像は未コミット**。下の 4 ファイルをこの名前で置くこと）

| ファイル | 内容 | 使い方 |
|---|---|---|
| `01-front-tpose.jpg` | 正面・T ポーズの全身 | **Charakuru の入力はこれ 1 枚** |
| `02-front-back.jpg` | 正面 + 背面と高さの基準線 | 髪・上着の背面を伝える参考 |
| `03-top.jpg` | 真上から | 参考（髪の広がり） |
| `04-bottom.jpg` | 真下から | **使わない。** 形が崩れている（足裏が過大で胴体が潰れている） |

キャラクターの特徴: 長い銀髪、薄紫の瞳、緑のカーディガン、淡緑のシャツ、白のプリーツスカート、黒タイツ、白緑のスニーカー。

## 方針

- ツールは [Charakuru](https://github.com/nanocle/Charakuru)（全身イラスト 1 枚 → VRM 1.0）。Releases の zip を使う（リポジトリ本体のソースにはキットが入っていない）
- **このリポジトリの外**に展開して作業する。キットのアセットは単独で持ち出し・再配布できず、再配布や組み込みは作者への事前連絡が要る（個人の私的利用は可）。**キットも出来上がった VRM もコミットしない**（`agent/data/` は gitignore。VRM は PVC へ手で置く）
- 以下は README を読んだ時点の理解。**`docs/tutorial.md` は未確認** —— 実行前に読むこと

## 必要なもの（手元の PC）

- Node.js 22 以上、Chromium 系ブラウザ
- Codex（画像生成とブラウザ操作ができるもの）。**Claude Code で代用できるかは未確認**
- Tripo のアカウント（ブラウザでログイン。料金・規約は利用者負担）
- Blender 5.2 + VRM Add-on for Blender + Blender MCP

このリポジトリを動かしているクラウドのセッションには、どれも入っていない。**手元の PC でやる作業。**

## 手順

1. Releases から `charakuru-<version>-….zip` を取り、リポジトリの外へ展開する
2. 展開したフォルダを Codex で開き、ルートの `AGENTS.md` を読ませて依頼する
3. `01-front-tpose.jpg` を入力にする（PNG / JPEG / WebP、20MB まで）
4. エージェントが起動するアプリ（`http://127.0.0.1:8766`、手動なら `npm start`）で、利用者が判断する: 頭・体の画像の確認 → 3D 候補（頭 4 案・体 4 案）の選択 → 体型の調整 → 歩行モーションの確認
5. VRM 1.0 と作業用 `.blend` が出る

## 出来た VRM を yachi8000 に載せる前の確認

Charakuru の既知の制限が、こちらの要件とぶつかる。**ここが追加の作業。**

- **表情が無い。** README に「新規キャラクターの顔は表情がなく、視線も固定」とある。yachi8000 は次の Blend Shape を使う
  - 口形（F-21）: `aa` `ih` `ou` `ee` `oh`
  - 表情（F-24）: `happy` `angry` `sad` `relaxed` `surprised`（`neutral` が待機）
  - 無ければ Blender の VRM Add-on で作って足す。**モデル固有の名前（`Fcl_ALL_Joy` 等）は設定が受け付けない**（→ `docs/setup/avatar.md`）
- **髪の物理（spring bone）。** 髪がとても長い。書き出し後にブラウザで揺れ方・貫通を見て調整する（アプリ内の歩行確認は物理を見ない）
- **身長に合わせた `camera`。** `avatar.camera.targetHeight` / `distance` を決め直す（合っていないと画面の外に立つ）
- **身振り（F-25）は別件。** VRMA の素材が未配置（→ Q-27）

## 置く

`docs/setup/avatar.md` の「置き場所」のとおり。開発は `agent/data/avatar.vrm`、本番は PVC 上の `/data/avatar.vrm`。

## 次のセッションでやること

1. 手元で Charakuru を回して VRM を作る（上の手順 1〜5）
2. 表情・口形の Blend Shape の有無を VRM から読んで検査する（検査スクリプトは未作成）
3. 足りなければ Blender で足す
4. `agent/data/avatar.vrm` に置き、`web/` で口形・表情・髪の揺れを見る
