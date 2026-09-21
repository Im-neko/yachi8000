import { describe, expect, it, vi } from 'vitest';
import type { Notification } from '../domain/notification.ts';
import type { Settings } from '../domain/settings.ts';
import { hasNoTarget, selectSpeechTargets } from '../domain/speech-audience.ts';
import {
  lastNotificationAcceptedAt,
  type NotifyDependencies,
  notify,
} from './notify.ts';

const NOTIFICATION: Notification = {
  source: 'claude-code',
  body: '作業が完了しました。',
};

interface Harness {
  deps: NotifyDependencies;
  spoken: string[];
  sent: Array<{ channelId: string; text: string }>;
}

/** 読み上げず、書き換えも通さずに残る文面。 */
const RECORDED = 'claude-code からのメッセージです。作業が完了しました。';

function createHarness(options: {
  connected: boolean;
  /** 接続中の VC のサーバ。宛先を指定した通知は同じサーバのときだけ読み上げる。 */
  guildId?: string;
  /** 音を鳴らせると名乗っているブラウザの数（F-23, D-40）。 */
  listeningBrowsers?: number;
  rewrite?: (notification: Notification) => Promise<string>;
  send?: () => Promise<void>;
  notification?: Settings['notification'];
}): Harness {
  const spoken: string[] = [];
  const sent: Array<{ channelId: string; text: string }> = [];
  const settings = {
    notification: options.notification ?? { whenNoOutput: 'drop' },
  } as Settings;

  return {
    spoken,
    sent,
    deps: {
      rewriter: {
        rewrite: options.rewrite ?? (async () => '書き換えた文'),
      },
      speech: {
        speak: ({ text }) => {
          spoken.push(text);
        },
        // 出口の選び方は domain の関数そのものを使う。ここで条件を書き写すと、
        // 規則が 2 箇所になって必ず食い違う。
        canSpeak: (origin) =>
          !hasNoTarget(
            selectSpeechTargets(origin, {
              voiceGuildId: options.connected
                ? (options.guildId ?? 'g')
                : undefined,
              listeningBrowsers: options.listeningBrowsers ?? 0,
            }),
          ),
        pending: () => 0,
      },
      text: {
        send:
          options.send ??
          (async (channelId, text) => {
            sent.push({ channelId, text });
          }),
      },
      settings: { get: () => settings },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

describe('notify', () => {
  it('VC に接続していれば通知優先度で読み上げる', async () => {
    const { deps, spoken } = createHarness({ connected: true });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('spoken');
    expect(spoken).toEqual(['書き換えた文']);
  });

  it('書き換えに失敗したらテンプレートへ縮退し、必ず WARN を出す', async () => {
    const { deps, spoken } = createHarness({
      connected: true,
      rewrite: async () => {
        throw new Error('proxy is down');
      },
    });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('spoken');
    expect(spoken).toEqual([
      'claude-code からのメッセージです。作業が完了しました。',
    ]);
    expect(deps.log.warn).toHaveBeenCalledOnce();
  });

  // 書き換え（F-16）は読み上げを自然にするためのもの。残る文面の数値や固有名詞を
  // 書き換えてよい理由にはならない（→ D-31）。
  it('未接続かつ text 設定なら、書き換えを通さない文面をテキストチャンネルへ配信する', async () => {
    const rewrite = vi.fn(async () => '書き換えた文');
    const { deps, sent, spoken } = createHarness({
      connected: false,
      rewrite,
      notification: { whenNoOutput: 'text', fallbackChannelId: '123' },
    });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('delivered-as-text');
    expect(sent).toEqual([{ channelId: '123', text: RECORDED }]);
    expect(spoken).toEqual([]);
    // 読み上げないのだから、書き換えのために LLM を呼ぶ理由がない。
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('テキスト配信にも失敗したら破棄し、ERROR を出す', async () => {
    const { deps } = createHarness({
      connected: false,
      notification: { whenNoOutput: 'text', fallbackChannelId: '123' },
      send: async () => {
        throw new Error('channel is gone');
      },
    });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('dropped');
    expect(deps.log.error).toHaveBeenCalledOnce();
  });

  it('未接続かつ drop 設定なら破棄し、WARN を出す', async () => {
    const { deps, spoken } = createHarness({ connected: false });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('dropped');
    expect(spoken).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalledOnce();
  });

  it('role は書き換え役へそのまま渡し、縮退時の文面にも出す', async () => {
    const handed: Notification[] = [];
    const withRole: Notification = {
      ...NOTIFICATION,
      role: 'CI を直している人',
    };

    const { deps: ok, spoken } = createHarness({
      connected: true,
      rewrite: async (notification) => {
        handed.push(notification);
        return '書き換えた文';
      },
    });
    await notify(ok, withRole);
    expect(handed).toEqual([withRole]);
    expect(spoken).toEqual(['書き換えた文']);

    // 書き換えが落ちても「誰が」は消えない。並行して動く送信元を
    // 区別できないと通知の意味がなくなる。
    const { deps: degraded, spoken: fallback } = createHarness({
      connected: true,
      rewrite: async () => {
        throw new Error('proxy is down');
      },
    });
    await notify(degraded, withRole);
    expect(fallback).toEqual([
      'claude-code（CI を直している人） からのメッセージです。作業が完了しました。',
    ]);
  });

  it('届けられなかった通知では受理時刻を進めない', async () => {
    await notify(createHarness({ connected: true }).deps, NOTIFICATION);
    const afterSpoken = lastNotificationAcceptedAt();

    await notify(createHarness({ connected: false }).deps, NOTIFICATION);

    expect(lastNotificationAcceptedAt()).toBe(afterSpoken);
  });
});

/**
 * 宛先を名前で指定した通知（D-31）。
 *
 * 記録が主で読み上げが従。通話中かどうかで「残るか消えるか」が変わらないこと
 * が、この経路を足した理由そのもの。
 */
describe('notify（宛先を指定した通知）', () => {
  const ADDRESSED: Notification = { ...NOTIFICATION, channel: 'money' };
  const CHANNELS = {
    money: { guildId: 'g', channelId: '456' },
  } as const;

  function harness(options: { connected: boolean; guildId?: string }) {
    return createHarness({
      ...options,
      notification: { whenNoOutput: 'drop', channels: CHANNELS },
    });
  }

  it('VC に未接続でも、指定されたチャンネルへ必ず残す', async () => {
    const { deps, sent, spoken } = harness({ connected: false });

    await expect(notify(deps, ADDRESSED)).resolves.toBe('delivered-as-text');
    expect(sent).toEqual([{ channelId: '456', text: RECORDED }]);
    expect(spoken).toEqual([]);
  });

  // 通話中に読み上げただけで終わると、#金 に何も残らない。
  it('同じサーバの VC にいれば、読み上げたうえで残す', async () => {
    const { deps, sent, spoken } = harness({ connected: true, guildId: 'g' });

    await expect(notify(deps, ADDRESSED)).resolves.toBe('spoken-and-delivered');
    expect(spoken).toEqual(['書き換えた文']);
    expect(sent).toEqual([{ channelId: '456', text: RECORDED }]);
  });

  // 別サーバの VC で読み上げると、関係のない人へ内容が漏れる（F-31 と同じ規則）。
  it('別のサーバの VC にいるときは読み上げず、残すだけにする', async () => {
    const { deps, sent, spoken } = harness({
      connected: true,
      guildId: 'other',
    });

    await expect(notify(deps, ADDRESSED)).resolves.toBe('delivered-as-text');
    expect(spoken).toEqual([]);
    expect(sent).toEqual([{ channelId: '456', text: RECORDED }]);
  });

  // 名前を間違えた通知が別のチャンネルへ出る方が、届かないことより悪い。
  it('設定に無い宛先は既定の配信先へ回さず、送信元の誤りとして返す', async () => {
    const { deps, sent, spoken } = createHarness({
      connected: true,
      notification: {
        whenNoOutput: 'text',
        fallbackChannelId: '123',
        channels: CHANNELS,
      },
    });

    await expect(
      notify(deps, { ...NOTIFICATION, channel: 'gold' }),
    ).resolves.toBe('unknown-channel');
    expect(sent).toEqual([]);
    expect(spoken).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalledOnce();
  });

  it('読み上げが届いていれば、テキストに失敗しても受理として扱う', async () => {
    const { deps, spoken } = createHarness({
      connected: true,
      guildId: 'g',
      notification: { whenNoOutput: 'drop', channels: CHANNELS },
      send: async () => {
        throw new Error('channel is gone');
      },
    });

    await expect(notify(deps, ADDRESSED)).resolves.toBe('spoken');
    expect(spoken).toEqual(['書き換えた文']);
    expect(deps.log.error).toHaveBeenCalledOnce();
  });

  it('読み上げもテキストも届かなければ破棄し、ERROR を出す', async () => {
    const { deps } = createHarness({
      connected: false,
      notification: { whenNoOutput: 'drop', channels: CHANNELS },
      send: async () => {
        throw new Error('channel is gone');
      },
    });

    await expect(notify(deps, ADDRESSED)).resolves.toBe('dropped');
    expect(deps.log.error).toHaveBeenCalledOnce();
  });
});
