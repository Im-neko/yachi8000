import { defineConfig } from 'vite';

/**
 * アバターのビューアと設定 UI（F-20, F-61）。
 *
 * **agent とは別のビルド。** 成果物は agent が配信する（→ D-36 の 5）。
 * 同一オリジンにしておくと、設定 UI が API を叩くときに CORS の設計が
 * 要らなくなる。
 *
 * 開発時はこの dev サーバを別に立て、API だけ agent へ回す。**本番の
 * 配信経路（agent が静的ファイルを返す）とは別物**なので、ここで通っても
 * 本番で通るとは限らない —— 確認は `npm run build` した成果物で行う。
 */
export default defineConfig({
  server: {
    // agent の dev サーバが 5173 を取るので、こちらはずらす。
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:5173', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // **ページは 2 枚**（→ D-44）。アバターは canvas を全画面に広げ、設定は
    // 縦に伸びるフォームで、土台のスタイルが噛み合わない。分けておくと
    // 設定を開くために 10 MB の VRM を読む必要もない。
    rollupOptions: {
      input: {
        index: 'index.html',
        settings: 'settings.html',
      },
    },
  },
});
