import type { VRM } from '@pixiv/three-vrm';
import {
  createVRMAnimationHumanoidTracks,
  VRMAnimationLoaderPlugin,
} from '@pixiv/three-vrm-animation';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { type AvatarGesture, gestureMotionUrl } from './api.ts';

/**
 * 発話に合わせた身振り（F-25, → D-42）。
 *
 * **素材（VRMA）は agent が配る。** 中身はボーンの回転だけを取り出して使う
 * —— `createVRMAnimationClip()` は**表情と視線のトラックも一緒に詰める**ので、
 * そのまま使うと F-24 の表情・F-21 の口形・「見ている人を見る」視線と
 * 正面衝突する（→ D-42 の 4）。
 */

/** 待機から身振りへ寄る時間（秒）。 */
const FADE_IN_SECONDS = 0.25;
/** 身振りから待機へ戻る時間（秒）。**戻りのほうを長くする**（急に戻ると飛ぶ）。 */
const FADE_OUT_SECONDS = 0.4;

export interface GesturePlayer {
  /**
   * 素材を読み込む。**読めなかったものは黙って持たない** ——
   * 出せない身振りはサーバ側が流さないので、ここで騒ぐ必要はない。
   */
  load(vrm: VRM, gestures: readonly AvatarGesture[]): Promise<void>;
  /** 1 回だけ再生する。**再生中なら何もしない。** */
  play(gesture: AvatarGesture): void;
  /** **`vrm.update()` より先、待機の姿勢より後に呼ぶ。** */
  update(delta: number): void;
  dispose(): void;
}

export function createGesturePlayer(): GesturePlayer {
  let mixer: THREE.AnimationMixer | undefined;
  const clips = new Map<AvatarGesture, THREE.AnimationClip>();
  /** 再生中のもの。終わりまで面倒を見る。 */
  let playing:
    | { action: THREE.AnimationAction; duration: number; fading: number }
    | undefined;

  function stop(): void {
    playing?.action.stop();
    playing = undefined;
  }

  return {
    async load(vrm, gestures) {
      stop();
      clips.clear();
      mixer = new THREE.AnimationMixer(vrm.scene);

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

      await Promise.all(
        gestures.map(async (gesture) => {
          try {
            const gltf = await loader.loadAsync(gestureMotionUrl(gesture));
            const animations = gltf.userData.vrmAnimations as
              | unknown[]
              | undefined;
            const animation = animations?.[0];
            if (!animation) return;

            // **回転だけを取る。** hips の移動（ルートモーション）も外す ——
            // その場で動いてほしいので、立ち位置は変えさせない。
            const { rotation } = createVRMAnimationHumanoidTracks(
              animation as Parameters<
                typeof createVRMAnimationHumanoidTracks
              >[0],
              vrm.humanoid,
              vrm.meta.metaVersion,
            );
            const duration = (animation as { duration: number }).duration;
            clips.set(
              gesture,
              new THREE.AnimationClip(gesture, duration, [
                ...rotation.values(),
              ]),
            );
          } catch {
            // 読めなければ持たない。**出さないだけで、表示は壊れない。**
          }
        }),
      );
    },

    play(gesture) {
      if (!mixer || playing) return;
      const clip = clips.get(gesture);
      if (!clip) return;

      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      // **最後の姿勢で止める。** 止めた瞬間に手を離すと待機へ飛ぶので、
      // 保持したまま重みを落として戻す。
      action.clampWhenFinished = true;
      action.reset().fadeIn(FADE_IN_SECONDS).play();
      playing = { action, duration: clip.duration, fading: 0 };
    },

    update(delta) {
      if (!mixer) return;
      mixer.update(delta);
      if (!playing) return;

      if (playing.action.time < playing.duration) return;

      // 再生し切った。ここから待機へ戻す。
      if (playing.fading === 0) playing.action.fadeOut(FADE_OUT_SECONDS);
      playing.fading += delta;
      if (playing.fading >= FADE_OUT_SECONDS) stop();
    },

    dispose() {
      stop();
      mixer?.stopAllAction();
      mixer = undefined;
      clips.clear();
    },
  };
}
