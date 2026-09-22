/**
 * 顔検出（F-26）の wasm を `public/` へ複製する。
 *
 * **実行時に外部の CDN を取りに行かない**（→ D-46 の 3）。認証の内側にある
 * ページが、外のサービスに依存してしまうため。
 *
 * **リポジトリには入れない。** 1 つ 11MB あり、public なリポジトリに置く
 * ものではない（VRM をコミットしないのと同じ理由 → D-36 の 3）。`npm run
 * dev` と `npm run build` の前に毎回ここから複製する。
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(
  here,
  '..',
  'node_modules',
  '@mediapipe',
  'tasks-vision',
  'wasm',
);
const to = join(here, '..', 'public', 'mediapipe');

/**
 * SIMD が使える環境と使えない環境で読む物が違う（FilesetResolver が実行時に
 * 選ぶ）。**両方置く** —— 片方だけだと、古い端末で黙って動かない。
 */
const NEEDED = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const available = await readdir(from).catch(() => {
  throw new Error(
    `${from} が見つかりません。npm install を先に実行してください。`,
  );
});

await mkdir(to, { recursive: true });
for (const name of NEEDED) {
  if (!available.includes(name)) {
    throw new Error(`@mediapipe/tasks-vision に ${name} がありません。`);
  }
  await copyFile(join(from, name), join(to, name));
}
console.log(`顔検出の wasm を ${NEEDED.length} 件複製しました。`);
