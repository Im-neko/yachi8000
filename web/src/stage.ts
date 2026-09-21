import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type {
  AvatarConfig,
  AvatarState,
  VisemeTimeline,
  VrmExpressionPreset,
} from './api.ts';
import { createIdlePose } from './pose.ts';

export interface Stage {
  /** VRM を読み込んで差し替える。前のモデルは破棄する（F-62）。 */
  load(url: string, config: AvatarConfig): Promise<void>;
  /** 読み込みの進み具合（0〜1）。分からないときは undefined。 */
  onProgress(handler: (ratio: number | undefined) => void): void;
  /**
   * 1 文ぶんの口形を流す（F-21）。
   *
   * `elapsed` を渡すと**その時計で引く** —— ブラウザでも音を鳴らしている
   * なら再生位置を渡す。そうすれば音と口は原理的にずれない（→ D-39 の 2）。
   * 渡さなければ、受け取った時刻を 0 秒として動かす。
   */
  speak(lipSync: VisemeTimeline, elapsed?: () => number): void;
  /** 会話の状態を反映する（F-22）。 */
  setState(state: AvatarState): void;
  /**
   * 顔に出す感情を差し替える（F-24）。`weight` が 0 なら素の顔へ戻す。
   *
   * **いつ戻すかはサーバが決める**（発話が終わると 0 が来る）。ここで
   * 状態の変化に合わせて勝手に消すと、同じ規則が 2 か所に散る。
   */
  setExpression(expression: VrmExpressionPreset, weight: number): void;
  dispose(): void;
}

/**
 * 表情が目標値へ寄る時定数（秒）。
 *
 * **口形を段差で切り替えると、モーラごとに口がパチパチ弾ける。** かといって
 * 遅すぎると、短いモーラが隣に埋もれて口が開かない。1 モーラは速い話速で
 * 0.05 秒ほどなので、その内に 8 割方たどり着く速さにしてある。
 *
 * **フレームレートに依らせない。** `delta * 係数` で寄せると、60fps と
 * 20fps で見た目の速さが変わる（重い機械ほど口が速く切り替わる、という
 * 逆立ちした挙動になる）。
 */
const VISEME_ATTACK_SECONDS = 0.03;

/**
 * 感情が目標値へ寄る時定数（秒）。
 *
 * **口形と同じ速さで動かさない。** 0.03 秒で表情が変わると、顔が切り替わる
 * というより**差し替わる**。人の表情はそこまで速くないので、目に付く。
 */
const EMOTION_ATTACK_SECONDS = 0.25;

/**
 * **速く動かすもの**。口形（F-21）とまばたき。
 *
 * 感情（0.25 秒）と同じ速さで動かすと、まばたきは「目をつぶる」になり、
 * 口は隣のモーラに埋もれる。
 */
const FAST_EXPRESSIONS: ReadonlySet<string> = new Set([
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
]);

/**
 * three.js の土台（F-20）。
 *
 * **描画はすべてブラウザで行う**（INV-2, D-02）。サーバは VRM と設定を
 * 返すだけで、three.js はここにしか無い。
 */
export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12141a);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  // MToon は自前の陰影を持つので、光源は形が見える最小限でよい。
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(1, 2, 1);
  scene.add(key);

  let current: VRM | undefined;
  let idleExpression: AvatarConfig['idleExpression'] = 'neutral';
  let state: AvatarState = 'idle';
  /** 今の感情（F-24）。`weight` が 0 なら出していない。 */
  let emotion: { expression: VrmExpressionPreset; weight: number } = {
    expression: 'neutral',
    weight: 0,
  };
  /** 再生中の口形と、その先頭からの秒数を返す時計。 */
  let lipSync: { timeline: VisemeTimeline; elapsed: () => number } | undefined;
  /** 今の重み。目標へ向かって毎フレーム寄せる。 */
  const weights = new Map<string, number>();
  /** 待機の姿勢・呼吸・まばたき。**T ポーズのまま立たせないため。** */
  const idle = createIdlePose();
  /** いまのまばたきの重み。毎フレーム進める。 */
  let blink = 0;
  let progressHandler: (ratio: number | undefined) => void = () => undefined;
  // Clock は r183 で非推奨。Timer は Page Visibility API を使えるので、
  // タブが隠れている間に溜まった時間を delta に流し込まない（揺れものが暴れる）。
  const timer = new THREE.Timer();
  timer.connect(document);
  let running = true;

  function resize(): void {
    const { clientWidth, clientHeight } = canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  /** 読み終わった口形を片付ける。**引くほうでは触らない**（読みと書きを混ぜない）。 */
  function expireLipSync(): void {
    if (!lipSync) return;
    if (lipSync.elapsed() > lipSync.timeline.duration) lipSync = undefined;
  }

  /**
   * 今の口形。**時刻で引く** —— フレームレートに合わせて進めると、重いときに
   * 口が声から遅れていく（しかも遅れが戻らない）。
   */
  function currentViseme(): string | undefined {
    if (!lipSync) return undefined;
    const elapsed = lipSync.elapsed();
    let viseme: string | undefined;
    for (const candidate of lipSync.timeline.frames) {
      if (candidate.at > elapsed) break;
      viseme = candidate.viseme;
    }
    return viseme === 'sil' ? undefined : viseme;
  }

  /**
   * 目標の表情。会話の状態（F-22）・感情（F-24）・口形（F-21）を重ねる。
   *
   * **話している間は待機の表情を薄める。** 待機の表情（`happy` など）は口も
   * 作るので、そのままだと口形と引っ張り合って、どちらも半端になる。
   *
   * **感情が出ている間は待機の表情を出さない。** どちらも同じプリセットの
   * 層にいるので、足すと混ざって別の顔になる（`happy` + `sad` は困った顔
   * ではなく、ただの崩れた顔）。**置き換える**のが正しい重ね方で、
   * 口形だけが常に上に乗る（→ D-41 の 2）。
   */
  function targetExpressions(): Map<string, number> {
    const target = new Map<string, number>();
    const add = (name: string, weight: number) =>
      target.set(name, Math.min(1, (target.get(name) ?? 0) + weight));

    if (emotion.weight > 0) add(emotion.expression, emotion.weight);
    else if (state === 'speaking') add(idleExpression, 0.4);
    else if (state === 'thinking') {
      add(idleExpression, 0.3);
      add('relaxed', 0.6);
    } else add(idleExpression, 1);

    const viseme = currentViseme();
    if (viseme) add(viseme, 1);
    // **まばたきは他と足し合わせない層。** 表情が `overrideBlink` を宣言して
    // いれば、three-vrm 側が勝手に薄めてくれる（笑っている間は目が細いまま）。
    if (blink > 0) add('blink', blink);
    return target;
  }

  function applyExpressions(delta: number): void {
    expireLipSync();
    const manager = current?.expressionManager;
    if (!manager) return;

    const target = targetExpressions();
    // 目標から消えたものも 0 へ向けて戻す。放っておくと前の表情が残る。
    for (const name of weights.keys()) {
      if (!target.has(name)) target.set(name, 0);
    }

    for (const [name, goal] of target) {
      const rate =
        1 -
        Math.exp(
          -delta /
            (FAST_EXPRESSIONS.has(name)
              ? VISEME_ATTACK_SECONDS
              : EMOTION_ATTACK_SECONDS),
        );
      const value =
        (weights.get(name) ?? 0) + (goal - (weights.get(name) ?? 0)) * rate;
      if (goal === 0 && value < 0.01) weights.delete(name);
      else weights.set(name, value);
      manager.setValue(name, goal === 0 && value < 0.01 ? 0 : value);
    }
  }

  function frame(): void {
    if (!running) return;
    requestAnimationFrame(frame);
    timer.update();
    const delta = timer.getDelta();
    blink = idle.blink(delta);
    applyExpressions(delta);
    // **姿勢は VRM の update より先に当てる。** 正規化ボーンへ書いた回転を
    // 実ボーンへ写すのが update の仕事なので、後から書いても 1 フレーム遅れる。
    if (current) idle.update(current, delta);
    // 揺れもの・表情・視線はすべて VRM 側の update が進める。
    current?.update(delta);
    controls.update();
    renderer.render(scene, camera);
  }
  frame();

  function unload(): void {
    if (!current) return;
    scene.remove(current.scene);
    VRMUtils.deepDispose(current.scene);
    current = undefined;
  }

  return {
    async load(url, config) {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));

      const gltf = await loader.loadAsync(url, (event) => {
        progressHandler(
          event.lengthComputable ? event.loaded / event.total : undefined,
        );
      });
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) {
        throw new Error(
          'VRM として読めませんでした（VRM の拡張がありません）。',
        );
      }

      // 描画に効かない頂点とスケルトンを畳む。大きいモデルほど効く。
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      // VRM 0.x は前方が VRM 1.0 と逆を向く。1.0 では何もしない。
      VRMUtils.rotateVRM0(vrm);

      unload();
      scene.add(vrm.scene);
      current = vrm;

      // **T ポーズのまま立たせない**（→ Q-27）。素材を持ち込まなくても、
      // ボーンを寝かせるだけで待機の見た目は作れる。
      idle.apply(vrm);
      // 見ている人を見る。**カメラはシーンに入れていない**が、描画のたびに
      // three.js が行列を更新するので、そのまま注視点として使える。
      if (vrm.lookAt) vrm.lookAt.target = camera;

      // 待機時の表情（→ D-36 の 1）。プリセット名しか受け取らないので、
      // モデルを差し替えても同じ名前で通る。実際に当てるのは毎フレームの
      // applyExpressions で、ここでは目標だけを覚える。
      idleExpression = config.idleExpression;
      weights.clear();
      lipSync = undefined;
      emotion = { expression: 'neutral', weight: 0 };

      const { targetHeight, distance } = config.camera;
      controls.target.set(0, targetHeight, 0);
      camera.position.set(0, targetHeight, distance);
      controls.update();
      resize();
    },

    onProgress(handler) {
      progressHandler = handler;
    },

    speak(timeline, elapsed) {
      // 前の文がまだ残っていても置き換える。発話は 1 本の経路から順に
      // 来る（INV-5）ので、重なっているなら前のほうが古い。
      const startedAt = performance.now();
      lipSync = {
        timeline,
        elapsed: elapsed ?? (() => (performance.now() - startedAt) / 1000),
      };
    },

    setExpression(expression, weight) {
      emotion = { expression, weight };
    },

    setState(next) {
      state = next;
      // 話し終わったら口を閉じる。イベントが落ちて開きっぱなしになるより、
      // 閉じすぎるほうがまだ見られる。
      if (next !== 'speaking') lipSync = undefined;
    },

    dispose() {
      running = false;
      lipSync = undefined;
      emotion = { expression: 'neutral', weight: 0 };
      timer.dispose();
      observer.disconnect();
      controls.dispose();
      unload();
      renderer.dispose();
    },
  };
}
