import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { AvatarConfig } from './api.ts';

export interface Stage {
  /** VRM を読み込んで差し替える。前のモデルは破棄する（F-62）。 */
  load(url: string, config: AvatarConfig): Promise<void>;
  /** 読み込みの進み具合（0〜1）。分からないときは undefined。 */
  onProgress(handler: (ratio: number | undefined) => void): void;
  dispose(): void;
}

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

  function frame(): void {
    if (!running) return;
    requestAnimationFrame(frame);
    timer.update();
    const delta = timer.getDelta();
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

      // 待機時の表情（→ D-36 の 1）。プリセット名しか受け取らないので、
      // モデルを差し替えても同じ名前で通る。
      vrm.expressionManager?.setValue(config.idleExpression, 1);

      const { targetHeight, distance } = config.camera;
      controls.target.set(0, targetHeight, 0);
      camera.position.set(0, targetHeight, distance);
      controls.update();
      resize();
    },

    onProgress(handler) {
      progressHandler = handler;
    },

    dispose() {
      running = false;
      timer.dispose();
      observer.disconnect();
      controls.dispose();
      unload();
      renderer.dispose();
    },
  };
}
