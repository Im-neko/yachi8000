import {
  AVATAR_MODEL_URL,
  fetchAvatarConfig,
  speechAudioUrl,
  subscribeAvatarEvents,
} from './api.ts';
import { createSpeechAudio } from './audio.ts';
import { createStage } from './stage.ts';
import './style.css';

const canvasElement = document.querySelector<HTMLCanvasElement>('#stage');
const statusElement = document.querySelector<HTMLParagraphElement>('#status');
const soundElement = document.querySelector<HTMLButtonElement>('#sound');
if (!canvasElement || !statusElement || !soundElement) {
  throw new Error('ページの土台が見つかりません。');
}
const canvas: HTMLCanvasElement = canvasElement;
const status: HTMLParagraphElement = statusElement;
const sound: HTMLButtonElement = soundElement;

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

/**
 * 読み上げをブラウザでも鳴らす（F-23）。**押されるまで鳴らない**
 * （→ D-39 の 3）。押せなかったら、その旨を出して口だけ動かす。
 */
const audio = createSpeechAudio();
sound.addEventListener('click', () => {
  audio
    .enable()
    .then(() => {
      sound.dataset.enabled = 'true';
    })
    .catch(() => {
      show('このブラウザでは音を鳴らせませんでした。口だけ動きます。');
    });
});

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
      if (event.kind !== 'speech') {
        stage.setState(event.state);
        return;
      }
      // **音を鳴らせたなら、その再生位置で口を引く**（→ D-39 の 2）。
      // 鳴らせなければ届いた時刻を 0 秒にする（今までと同じ）。
      audio
        .play(speechAudioUrl(event.speechId))
        .then((playback) => stage.speak(event.lipSync, playback?.elapsed))
        .catch(() => stage.speak(event.lipSync));
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
