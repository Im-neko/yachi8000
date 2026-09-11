import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
  // 空配列で組み込みプロバイダを 1 つも同梱しない。LLM の入口は
  // LLM プロキシだけ（D-17）で、app.ts が setProvider() で登録する。
  // 省略すると全組み込みプロバイダが登録され、設定ミスで意図しない
  // プロバイダへ直接出ていく経路が黙って残る。
  providers: [],
});
