import {
  AVATAR_MODEL_URL,
  fetchAvatarConfig,
  type Presence,
  reportPresence,
  sendUtterance,
  speechAudioUrl,
  subscribeAvatarEvents,
  UtteranceRejected,
} from './api.ts';
import { createSpeechAudio } from './audio.ts';
import { createMicrophone } from './mic.ts';
import { createPresenceWatcher } from './presence.ts';
import { createStage } from './stage.ts';
import './style.css';

const canvasElement = document.querySelector<HTMLCanvasElement>('#stage');
const statusElement = document.querySelector<HTMLParagraphElement>('#status');
const soundElement = document.querySelector<HTMLButtonElement>('#sound');
const micElement = document.querySelector<HTMLButtonElement>('#mic');
const heardElement = document.querySelector<HTMLParagraphElement>('#heard');
const cameraElement = document.querySelector<HTMLButtonElement>('#camera');
if (
  !canvasElement ||
  !statusElement ||
  !soundElement ||
  !micElement ||
  !heardElement ||
  !cameraElement
) {
  throw new Error('ページの土台が見つかりません。');
}
const canvas: HTMLCanvasElement = canvasElement;
const status: HTMLParagraphElement = statusElement;
const sound: HTMLButtonElement = soundElement;
const mic: HTMLButtonElement = micElement;
const heard: HTMLParagraphElement = heardElement;
const camera: HTMLButtonElement = cameraElement;

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
      // **サーバへ名乗り直す**（F-23, D-40）。名乗るまでこのタブは出口として
      // 数えられない —— 数えてしまうと、VC に誰もいないときの通知が無音へ
      // 向かって「喋った」ことになる。
      reconnect(true);
    })
    .catch((error: unknown) => {
      // **理由を出す。** 「鳴らせませんでした」だけだと、ブラウザが断った
      // のか音そのものが読めなかったのかが分からず、手元に端末が無いと
      // 追えない（実際にそれでスマートフォンの失敗を見失った）。
      show(
        `このブラウザでは音を鳴らせませんでした。口だけ動きます。\n${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    });
});

/**
 * マイクから話しかける（F-13 の経路 B、→ D-47）。押すと録り始め、
 * もう一度押すと送る。**押すまでマイクは開かない。**
 *
 * **黙って終わらせない。** 聞き取れた文も、聞き取れなかったことも、
 * 送れなかったことも画面に出す —— 音声入力の最悪の壊れ方は「話しかけたのに
 * 無言」で、利用者からは原因が何も分からない。
 */
const microphone = createMicrophone();

function showHeard(message: string): void {
  heard.textContent = message;
}

function setMicLabel(): void {
  const recording = microphone.recording();
  mic.dataset.recording = String(recording);
  mic.textContent = recording ? '送る' : '話しかける';
}

async function toggleMic(): Promise<void> {
  if (!microphone.recording()) {
    await microphone.start();
    setMicLabel();
    showHeard('聞いています…');
    return;
  }

  const recording = await microphone.stop();
  setMicLabel();
  if (!recording) {
    showHeard('何も録れませんでした。');
    return;
  }

  mic.disabled = true;
  showHeard('聞き取っています…');
  try {
    const result = await sendUtterance(recording.blob, recording.contentType);
    if (!result.heard) {
      // 2 秒に満たない発話は文字起こしが空を返す（→ D-16 の追記の 3）。
      // **「無言」で終わらせない。**
      showHeard('聞き取れませんでした（短すぎたかもしれません）。');
      return;
    }
    showHeard(
      `あなた: ${result.transcript}\n${result.reply ?? '（返事なし）'}`,
    );
  } catch (error) {
    if (error instanceof UtteranceRejected && error.rateLimited) {
      // **枠切れは出しっぱなしにする**（→ Q-29）。翌月まで戻らないので、
      // 押すたびに同じ失敗を見せるより、押す前に分かるほうがいい。
      showRateLimited(error.message);
      showHeard('');
      return;
    }
    showHeard(
      `送れませんでした。\n${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    mic.disabled = false;
  }
}

/**
 * 文字起こしの枠を使い切っていることを出し続ける（→ Q-29）。
 *
 * **ボタンは押せるままにする。** 枠が戻ったか（契約を変えたか）は
 * こちらからは分からないので、押して確かめられる状態を残す。
 */
function showRateLimited(message: string): void {
  mic.dataset.rateLimited = 'true';
  mic.title = message;
  show(`${message}\n「話しかける」はいま使えません。`);
}

mic.addEventListener('click', () => {
  toggleMic().catch((error: unknown) => {
    setMicLabel();
    mic.disabled = false;
    // 許可されなかった場合もここへ来る。理由をそのまま出す。
    showHeard(
      `マイクを使えませんでした。\n${
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      }`,
    );
  });
});

/**
 * カメラの前に人がいるかを見る（F-26、→ D-46）。
 *
 * **映像はこの端末から出ない。** 送るのは 3 値だけ。**押すまでカメラは
 * 開かない** —— 読み上げの「音を出す」（F-23）と同じ扱い。
 */
const PRESENCE_HEARTBEAT_MS = 60_000;

let presenceBeat: number | undefined;
let lastPresence: Presence = 'unknown';

const presence = createPresenceWatcher({
  onChange: (state) => {
    lastPresence = state;
    void reportPresence(state);
    showHeard(
      state === 'present'
        ? 'カメラ: 人がいます'
        : state === 'absent'
          ? 'カメラ: 人がいません'
          : 'カメラ: 分かりません',
    );
  },
});

function setCameraLabel(): void {
  const active = presence.active();
  camera.dataset.active = String(active);
  camera.textContent = active ? 'カメラを止める' : 'カメラを使う';
}

camera.addEventListener('click', () => {
  if (presence.active()) {
    presence.stop();
    if (presenceBeat !== undefined) clearInterval(presenceBeat);
    presenceBeat = undefined;
    setCameraLabel();
    return;
  }

  camera.disabled = true;
  showHeard('カメラの判定器を読み込んでいます…（初回は 10MB ほど）');
  presence
    .start()
    .then(() => {
      showHeard('カメラを見ています。');
      // **黙っている間も状態は続いている**ので、定期的に言い直す
      // （サーバ側は古い報告を数えない → D-46）。
      presenceBeat = window.setInterval(() => {
        void reportPresence(lastPresence);
      }, PRESENCE_HEARTBEAT_MS);
    })
    .catch((error: unknown) => {
      // 許可されなかった場合もここへ来る。理由をそのまま出す。
      showHeard(
        `カメラを使えませんでした。\n${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    })
    .finally(() => {
      camera.disabled = false;
      setCameraLabel();
    });
});

/** 素材の出どころ（→ D-42 の 2）。設定に無ければ何も出さない。 */
function showAttribution(text: string | undefined): void {
  const existing = document.querySelector('#attribution');
  existing?.remove();
  if (!text) return;
  const element = document.createElement('p');
  element.id = 'attribution';
  element.textContent = text;
  document.body.appendChild(element);
}

const stage = createStage(canvas);

/**
 * イベントの購読をつなぎ直す（F-21, F-22, F-23）。
 *
 * **音を鳴らせるかどうかはサーバ側の判断に効く**（→ D-40）ので、
 * 「音を出す」を押したら繋ぎ直して名乗り直す。`EventSource` は URL を
 * 後から変えられないため、閉じて開き直すのが唯一の手。
 */
let unsubscribe: (() => void) | undefined;
function reconnect(withAudio: boolean): void {
  unsubscribe?.();
  unsubscribe = subscribeAvatarEvents(
    (event) => {
      if (event.kind === 'state') {
        stage.setState(event.state);
        return;
      }
      if (event.kind === 'expression') {
        stage.setExpression(event.expression, event.weight);
        return;
      }
      if (event.kind === 'gesture') {
        stage.playGesture(event.gesture);
        return;
      }
      // **音を鳴らせたなら、その再生位置で口を引く**（→ D-39 の 2）。
      // 鳴らせなければ届いた時刻を 0 秒にする（今までと同じ）。
      audio
        .play(speechAudioUrl(event.speechId))
        .then((playback) => stage.speak(event.lipSync, playback?.elapsed))
        .catch(() => stage.speak(event.lipSync));
    },
    {
      audio: withAudio,
      onConnectionChange: (connected) => {
        show(connected ? '' : '発話イベントに繋がっていません（再接続中）。');
      },
    },
  );
}
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
  // **素材の出どころを出す。** 身振りのモーションには「クレジットを表記
  // すること」を条件にするライセンスがある（→ D-42 の 2）。設定に書かれて
  // いれば必ず画面に出す —— 出し忘れがライセンス違反になる類のもの。
  showAttribution(config.attribution);

  /**
   * 発話と会話状態を受け取る（F-21, F-22）。**モデルが映ってから繋ぐ** ——
   * 読み込みの数秒の間に来たイベントは、どのみち動かす先が無い。
   *
   * **繋がらなくてもアバターは映ったまま。** 口が動かないだけで、
   * 「表示できませんでした」にはしない（→ INV-7 の部分縮退）。
   */
  reconnect(audio.enabled());
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
