import {
  AVATAR_MODEL_URL,
  fetchAvatarConfig,
  subscribeAvatarEvents,
} from './api.ts';
import { createStage } from './stage.ts';
import './style.css';

const canvasElement = document.querySelector<HTMLCanvasElement>('#stage');
const statusElement = document.querySelector<HTMLParagraphElement>('#status');
if (!canvasElement || !statusElement) {
  throw new Error('ページの土台が見つかりません。');
}
const canvas: HTMLCanvasElement = canvasElement;
const status: HTMLParagraphElement = statusElement;

/**
 * 進み具合と失敗を画面に出す。
 *
 * **黙って白い画面にしない。** VRM は 10 MB 級で、読み込みに数秒かかるのが
 * 普通（→ D-36 の 2）。何も出ないと、遅いのか壊れたのか区別できない。
 */
function show(message: string, kind: 'info' | 'error' = 'info'): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

const stage = createStage(canvas);
stage.onProgress((ratio) => {
  show(
    ratio === undefined
      ? 'アバターを読み込んでいます…'
      : `アバターを読み込んでいます… ${Math.round(ratio * 100)}%`,
  );
});

try {
  const config = await fetchAvatarConfig();
  await stage.load(AVATAR_MODEL_URL, config);
  show('');

  /**
   * 発話と会話状態を受け取る（F-21, F-22）。**モデルが映ってから繋ぐ** ——
   * 読み込みの数秒の間に来たイベントは、どのみち動かす先が無い。
   *
   * **繋がらなくてもアバターは映ったまま。** 口が動かないだけで、
   * 「表示できませんでした」にはしない（→ INV-7 の部分縮退）。
   */
  subscribeAvatarEvents(
    (event) => {
      if (event.kind === 'speech') stage.speak(event.lipSync);
      else stage.setState(event.state);
    },
    (connected) => {
      show(connected ? '' : '発話イベントに繋がっていません（再接続中）。');
    },
  );
} catch (error) {
  // 失敗の中身をそのまま出す。「読み込めません」だけだと、モデルが置かれて
  // いないのか設定が間違っているのかが分からない。
  show(
    `アバターを表示できませんでした。\n${
      error instanceof Error ? error.message : String(error)
    }`,
    'error',
  );
}
