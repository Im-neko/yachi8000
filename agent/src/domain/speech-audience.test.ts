import { describe, expect, it } from 'vitest';
import {
  hasNoTarget,
  type OutputAvailability,
  selectSpeechTargets,
} from './speech-audience.ts';

const NOBODY: OutputAvailability = {
  listeningBrowsers: 0,
  presence: 'unknown',
};
const IN_VOICE: OutputAvailability = {
  voiceGuildId: 'g1',
  listeningBrowsers: 0,
  presence: 'unknown',
};
const BROWSER_ONLY: OutputAvailability = {
  listeningBrowsers: 1,
  presence: 'unknown',
};
const BOTH: OutputAvailability = {
  voiceGuildId: 'g1',
  listeningBrowsers: 1,
  presence: 'unknown',
};

describe('selectSpeechTargets', () => {
  it('出口がひとつも無ければ、どこへも出さない', () => {
    for (const origin of [
      { kind: 'notification' },
      { kind: 'reminder', guildId: 'g1' },
      { kind: 'conversation', guildId: 'g1' },
    ] as const) {
      expect(hasNoTarget(selectSpeechTargets(origin, NOBODY))).toBe(true);
    }
  });

  it('宛先の無い通知は、つながっている出口すべてへ出す', () => {
    const origin = { kind: 'notification' } as const;
    expect(selectSpeechTargets(origin, BOTH)).toEqual({
      voice: true,
      browser: true,
    });
    expect(selectSpeechTargets(origin, BROWSER_ONLY)).toEqual({
      voice: false,
      browser: true,
    });
  });

  // D-31。別サーバの VC で読み上げると、関係のない人へ内容が漏れる。
  it('宛先を指定された通知は、そのサーバの VC でしか読まない', () => {
    const origin = { kind: 'notification', guildId: 'other' } as const;
    expect(selectSpeechTargets(origin, BOTH)).toEqual({
      voice: false,
      browser: true,
    });
  });

  // F-12。別サーバや DM の発言を、繋いでいる VC で読むのは筋が通らない。
  it('会話とリマインダーは、同じサーバの VC でだけ読む', () => {
    expect(
      selectSpeechTargets({ kind: 'conversation', guildId: 'other' }, IN_VOICE),
    ).toEqual({ voice: false, browser: false });
    expect(
      selectSpeechTargets({ kind: 'reminder', guildId: 'g1' }, IN_VOICE),
    ).toEqual({ voice: true, browser: false });
  });

  // D-40。利用者は複数人いる前提で、ページを開いている人が DM の相手とは
  // 限らない（→ Q-26 が決まるまでの扱い）。
  it('DM の会話はブラウザへ出さない', () => {
    expect(selectSpeechTargets({ kind: 'conversation' }, BOTH)).toEqual({
      voice: false,
      browser: false,
    });
  });

  // D-47。話しかけた本人が画面の前にいるので、返事はそこへ返す。
  // VC にいる別の人へ、その人の声の相手の返事を流す筋は無い。
  it('ブラウザから話しかけられた応答はブラウザだけへ出す', () => {
    expect(selectSpeechTargets({ kind: 'web-conversation' }, BOTH)).toEqual({
      voice: false,
      browser: true,
    });
    expect(selectSpeechTargets({ kind: 'web-conversation' }, IN_VOICE)).toEqual(
      {
        voice: false,
        browser: false,
      },
    );
  });

  // F-26。画面の前に誰もいないと分かっているなら、そこへ向かって喋っても
  // 届かない。通知はテキストへ退避させたい（→ D-46 の 2）。
  it('カメラが「いない」と言っているブラウザは出口に数えない', () => {
    const empty: OutputAvailability = {
      listeningBrowsers: 1,
      presence: 'absent',
    };
    expect(selectSpeechTargets({ kind: 'notification' }, empty)).toEqual({
      voice: false,
      browser: false,
    });
  });

  // **「分からない」は数える。** カメラを使わない人が読み上げられなく
  // なってはいけない（→ D-46 の 2）。
  it('カメラを使っていなければ、今までどおり出口に数える', () => {
    expect(selectSpeechTargets({ kind: 'notification' }, BROWSER_ONLY)).toEqual(
      { voice: false, browser: true },
    );
  });

  it('カメラが「いる」と言っていれば出口に数える', () => {
    const watching: OutputAvailability = {
      listeningBrowsers: 1,
      presence: 'present',
    };
    expect(selectSpeechTargets({ kind: 'notification' }, watching)).toEqual({
      voice: false,
      browser: true,
    });
  });

  // F-23。既定は消音なので、見ているだけのタブを出口と数えると、通知が
  // 無音へ向かって「喋った」ことになり、テキストへの退避も止まる。
  it('音を鳴らせると名乗っていないタブは出口に数えない', () => {
    const watchingOnly: OutputAvailability = {
      listeningBrowsers: 0,
      presence: 'unknown',
    };
    expect(selectSpeechTargets({ kind: 'notification' }, watchingOnly)).toEqual(
      { voice: false, browser: false },
    );
  });
});
