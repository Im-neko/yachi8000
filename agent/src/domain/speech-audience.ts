import type { Presence } from './presence.ts';

/**
 * 「この発話をどの出口が受け取るか」を決める（→ D-40）。
 *
 * **Discord と Web は対等なインターフェース**で、どちらかがもう一方の
 * おまけではない。VC に入っていないから喋らない、ではなく、**受け取る出口が
 * ひとつも無いから喋らない**。判定はここに 1 つだけ置き、呼び出し側
 * （会話・通知・リマインダー）には持たせない —— 入口ごとに条件が散ると、
 * 出口を足すたびに全部を直すことになる。
 */

/**
 * 発話の出どころ。**宛先ではなく出どころ**を持つ点が要（どこへ出すかは
 * この値と出口の状態から導く）。
 */
export type SpeechOrigin =
  /** 会話の応答（F-01, F-12）。DM には `guildId` が無い。 */
  | { readonly kind: 'conversation'; readonly guildId?: string }
  /**
   * ブラウザから話しかけられた応答（F-13 の経路 B、→ D-47）。
   *
   * **VC へは出さない。** 話しかけた人は画面の前にいるので、そこへ返す。
   * VC にいる別の人へ、その人の声の相手の返事を流す筋は無い。
   */
  | { readonly kind: 'web-conversation' }
  /**
   * 外部通知（F-15）。宛先を名前で指定された通知（D-31）だけ `guildId` を持つ。
   * 宛先が無い通知は、つながっている出口すべてへ出す。
   */
  | { readonly kind: 'notification'; readonly guildId?: string }
  /** リマインダー（F-31）。登録されたサーバがあれば、それが宛先になる。 */
  | { readonly kind: 'reminder'; readonly guildId?: string };

/** いまつながっている出口の状態。 */
export interface OutputAvailability {
  /** 接続中の VC のサーバ。未接続なら undefined。 */
  readonly voiceGuildId?: string;
  /**
   * **音を鳴らせると名乗っている**ブラウザの数（F-23）。
   *
   * 見ているだけのタブは数えない。既定は消音なので、SSE をつないでいる
   * だけのタブを出口と数えると、**通知が無音へ向かって「喋った」ことになり、
   * テキストへの退避も止まる**（INV-7 に反する。→ D-40）。
   */
  readonly listeningBrowsers: number;
  /**
   * カメラの前に人がいるか（F-26、→ D-46）。
   *
   * **「いない」ときだけブラウザを出口から外す。** 「分からない」は今まで
   * どおり数える —— カメラを使わない人が読み上げられなくなってはいけない。
   */
  readonly presence: Presence;
}

/** どの出口へ出すか。両方 false なら、その発話に出口は無い。 */
export interface SpeechTargets {
  readonly voice: boolean;
  readonly browser: boolean;
}

/**
 * 出口を選ぶ。
 *
 * - **VC**: 通知はつながっていれば必ず受ける。会話とリマインダーは
 *   **同じサーバのときだけ**（F-12）。別サーバや DM の発言を、繋いでいる
 *   VC で読み上げるのは宛先として筋が通らない
 * - **ブラウザ**: 通知・リマインダー・サーバでの会話を受ける。
 *   **DM は受けない** —— 利用者は複数人いる前提で、ページを開いている人が
 *   DM の相手とは限らない（→ Q-26 は D-45 で決着したが、**対応表があっても
 *   「いま画面の前にいるのがその人か」までは分からない**ので、DM は出さない
 *   ままにしてある）
 * - **ブラウザから話しかけられた分**（`web-conversation`）は必ずブラウザへ。
 *   話しかけた本人がそこにいる
 * - **カメラが「いない」と言っているブラウザは出口に数えない**（F-26）。
 *   **「分からない」は数える** —— カメラを使わない人が読み上げられなく
 *   なってはいけない（→ D-46 の 2）
 */
export function selectSpeechTargets(
  origin: SpeechOrigin,
  availability: OutputAvailability,
): SpeechTargets {
  const inVoice = availability.voiceGuildId !== undefined;
  // **音を鳴らせると名乗っていて、かつ人がいないと分かっていない**タブだけ
  // を出口と数える（F-23, F-26）。画面の前に誰もいないと分かっているなら、
  // そこへ向かって喋っても届かない —— 通知はテキストへ退避させたい。
  const browserListening =
    availability.listeningBrowsers > 0 && availability.presence !== 'absent';

  switch (origin.kind) {
    case 'notification':
      // 宛先を指定された通知は、そのサーバの VC でしか読まない（D-31）。
      // 別サーバの VC で読み上げると関係のない人へ内容が漏れる。
      return {
        voice:
          inVoice &&
          (origin.guildId === undefined ||
            origin.guildId === availability.voiceGuildId),
        browser: browserListening,
      };
    case 'reminder':
      return {
        voice: inVoice && origin.guildId === availability.voiceGuildId,
        browser: browserListening,
      };
    case 'conversation':
      return {
        voice: inVoice && origin.guildId === availability.voiceGuildId,
        browser: browserListening && origin.guildId !== undefined,
      };
    case 'web-conversation':
      // **声で返すのは音を鳴らせるタブだけ。** 鳴らせなくても文字起こしと
      // 返事は HTTP の応答で画面に出るので、ここが false でも会話は成立する。
      return { voice: false, browser: browserListening };
  }
}

/** どこにも出せないか。 */
export function hasNoTarget(targets: SpeechTargets): boolean {
  return !targets.voice && !targets.browser;
}
