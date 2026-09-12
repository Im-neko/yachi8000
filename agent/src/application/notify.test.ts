import { describe, expect, it, vi } from 'vitest';
import type { Notification } from '../domain/notification.ts';
import type { Settings } from '../domain/settings.ts';
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

function createHarness(options: {
  connected: boolean;
  rewrite?: (notification: Notification) => Promise<string>;
  send?: () => Promise<void>;
  notification?: Settings['notification'];
}): Harness {
  const spoken: string[] = [];
  const sent: Array<{ channelId: string; text: string }> = [];
  const settings = {
    notification: options.notification ?? { whenNotInVoice: 'drop' },
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
        pending: () => 0,
      },
      voice: {
        join: async () => undefined,
        leave: () => false,
        current: () =>
          options.connected ? { guildId: 'g', channelId: 'c' } : undefined,
        play: async () => undefined,
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

  it('未接続かつ text 設定ならテキストチャンネルへ配信する', async () => {
    const { deps, sent, spoken } = createHarness({
      connected: false,
      notification: { whenNotInVoice: 'text', fallbackChannelId: '123' },
    });

    await expect(notify(deps, NOTIFICATION)).resolves.toBe('delivered-as-text');
    expect(sent).toEqual([{ channelId: '123', text: '書き換えた文' }]);
    expect(spoken).toEqual([]);
  });

  it('テキスト配信にも失敗したら破棄し、ERROR を出す', async () => {
    const { deps } = createHarness({
      connected: false,
      notification: { whenNotInVoice: 'text', fallbackChannelId: '123' },
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
