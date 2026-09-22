/**
 * カメラの前に人がいるかを見る（F-26、→ D-46）。
 *
 * **映像は端末から出さない。** 判定はここで終わらせ、外へ出すのは 3 値だけ。
 */

/**
 * **「いない」と「分からない」を分ける**（→ D-46 の 2）。
 *
 * 許可していない・タブが隠れた・カメラを他のアプリに取られた・判定器が
 * 落ちた —— これらは「いない」ではない。同じ値に潰すと、読み上げが理由の
 * 分からないまま止まる。
 */
export type Presence = 'present' | 'absent' | 'unknown';

/**
 * 見る間隔（→ D-46 の 4）。**人の出入りは秒単位の出来事ではない。**
 * スマートフォンを置きっぱなしにする使い方を想定している以上、毎フレーム
 * 推論する設計は成立しない（電池と発熱のほうが体験を壊す）。
 */
const INTERVAL_MS = 1_500;

/**
 * 何回続いたら切り替えるか。**1 回で切り替えない** —— 顔を伏せた一瞬や
 * 検出の取りこぼしで「いなくなった」ことにすると、読み上げが途切れる。
 */
const STABLE_COUNT = 2;

/** 判定に渡す映像の大きさ。**小さくてよい** —— 顔がいるかだけを見る。 */
const VIDEO_SIZE = { width: 320, height: 240 };

export interface PresenceWatcher {
  active(): boolean;
  /** 見始める。**利用者の操作の中で呼ぶ**（カメラの許可を求めるため）。 */
  start(): Promise<void>;
  /** 見るのをやめ、カメラを離す。状態は `unknown` になる。 */
  stop(): void;
}

export interface PresenceWatcherOptions {
  /** 状態が変わったときだけ呼ばれる。 */
  onChange: (state: Presence) => void;
}

/**
 * 判定器を読み込む。**押されるまで読まない**（→ D-46 の 3）。
 *
 * wasm だけで 11MB あり、カメラを使わない人にまで読ませるものではない。
 * **置き場所は自分のところ** —— 実行時に外部の CDN を取りに行くと、認証の
 * 内側のページが外のサービスに依存する。
 */
async function loadDetector() {
  const { FaceDetector, FilesetResolver } = await import(
    '@mediapipe/tasks-vision'
  );
  const fileset = await FilesetResolver.forVisionTasks('/mediapipe');
  return FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: '/models/blaze_face_short_range.tflite',
      // **CPU で足りる。** 320x240 を 1.5 秒に 1 回見るだけで、GPU を
      // 掴むほうが電池にも端末の相性にも響く。
      delegate: 'CPU',
    },
    runningMode: 'IMAGE',
  });
}

export function createPresenceWatcher(
  options: PresenceWatcherOptions,
): PresenceWatcher {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;

  let stream: MediaStream | undefined;
  let detector: Awaited<ReturnType<typeof loadDetector>> | undefined;
  let timer: number | undefined;
  let reported: Presence = 'unknown';
  /** 直前の生の判定と、それが何回続いたか。 */
  let pending: { state: Presence; count: number } = {
    state: 'unknown',
    count: 0,
  };

  function report(state: Presence): void {
    if (state === reported) return;
    reported = state;
    options.onChange(state);
  }

  /** 生の判定を均す。**続けて同じ結果が出たときだけ**外へ出す。 */
  function observe(state: Presence): void {
    pending =
      pending.state === state
        ? { state, count: pending.count + 1 }
        : { state, count: 1 };
    if (pending.count >= STABLE_COUNT) report(state);
  }

  function look(): void {
    if (!detector || video.readyState < 2) return;
    try {
      const found = detector.detect(video).detections.length > 0;
      observe(found ? 'present' : 'absent');
    } catch {
      // 判定器が落ちた。**「いない」ではない**ので unknown に倒す。
      report('unknown');
    }
  }

  function release(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = undefined;
    video.srcObject = null;
    pending = { state: 'unknown', count: 0 };
    report('unknown');
  }

  /**
   * **タブが隠れたら止める**（→ D-46 の 2）。スマートフォンは画面が消えると
   * カメラが止まる。止まったことに気付かず「いる」のまま放置しない。
   */
  document.addEventListener('visibilitychange', () => {
    if (!stream) return;
    if (document.hidden) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      pending = { state: 'unknown', count: 0 };
      report('unknown');
      return;
    }
    timer ??= window.setInterval(look, INTERVAL_MS);
  });

  return {
    active: () => stream !== undefined,

    async start(): Promise<void> {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', ...VIDEO_SIZE },
      });
      video.srcObject = stream;
      await video.play();
      try {
        detector ??= await loadDetector();
      } catch (error) {
        // 読み込めなければカメラも離す。**開いたままにしない** ——
        // 何も見ていないのに録画中の表示だけが残る。
        release();
        throw error;
      }
      look();
      timer = window.setInterval(look, INTERVAL_MS);
    },

    stop: release,
  };
}
