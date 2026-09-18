import { describe, expect, it, vi } from 'vitest';
import type { CreatedIssue, IssueDraft, IssueSource } from '../domain/issue.ts';
import type { Settings } from '../domain/settings.ts';
import { createIssueFromMessage, type IssueDependencies } from './issue.ts';

const SOURCE: IssueSource = {
  url: 'https://discord.com/channels/1/2/3',
  postedOn: '2026-09-18',
  text: '出来高急増をトリガーにした打診エントリーを試したい',
};

interface Harness {
  deps: IssueDependencies;
  created: Array<{ repository: string; draft: IssueDraft }>;
  marked: Array<{ channelId: string; messageId: string }>;
}

function createHarness(options?: {
  repositories?: Record<string, string>;
  create?: () => Promise<CreatedIssue>;
  markHandled?: () => Promise<void>;
}): Harness {
  const created: Array<{ repository: string; draft: IssueDraft }> = [];
  const marked: Array<{ channelId: string; messageId: string }> = [];
  const settings = {
    issueTracker: {
      repositories: options?.repositories ?? { '2': 'Im-neko/stocktrade' },
    },
  } as unknown as Settings;

  return {
    created,
    marked,
    deps: {
      tracker: {
        create:
          options?.create ??
          (async (repository, draft) => {
            created.push({ repository, draft });
            return { number: 1357, url: 'https://github.com/o/r/issues/1357' };
          }),
      },
      settings: { get: () => settings },
      marker: {
        markHandled:
          options?.markHandled ??
          (async (channelId, messageId) => {
            marked.push({ channelId, messageId });
          }),
      },
      log: { warn: vi.fn() },
    },
  };
}

function input() {
  return {
    channelId: '2',
    source: SOURCE,
    sourceMessageId: '3',
    title: '出来高急増の打診エントリーを検証する',
    body: '## 完了条件\n期待値が出ること',
    labels: ['idea'],
    instruction: 'Issue にして',
  };
}

describe('createIssueFromMessage', () => {
  it('チャンネルに対応するリポジトリへ立て、元投稿に印を付ける', async () => {
    const { deps, created, marked } = createHarness();

    const issue = await createIssueFromMessage(deps, input());

    expect(issue.number).toBe(1357);
    expect(created).toHaveLength(1);
    expect(created[0]?.repository).toBe('Im-neko/stocktrade');
    expect(created[0]?.draft.labels).toEqual(['idea']);
    expect(created[0]?.draft.body).toContain(SOURCE.url);
    expect(marked).toEqual([{ channelId: '2', messageId: '3' }]);
  });

  it('設定に無いチャンネルでは起票せずに理由を返す', async () => {
    const { deps, created } = createHarness({ repositories: {} });

    await expect(createIssueFromMessage(deps, input())).rejects.toThrow(
      /issueTracker.repositories/,
    );
    expect(created).toHaveLength(0);
  });

  it('タイトルが空なら起票しない', async () => {
    const { deps, created } = createHarness();

    await expect(
      createIssueFromMessage(deps, { ...input(), title: '   ' }),
    ).rejects.toThrow(/タイトル/);
    expect(created).toHaveLength(0);
  });

  it('印を付けられなくても Issue の結果は返す（棚卸しが出典リンクで気付ける）', async () => {
    const { deps } = createHarness({
      markHandled: async () => {
        throw new Error('missing permission');
      },
    });

    const issue = await createIssueFromMessage(deps, input());

    expect(issue.number).toBe(1357);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('起票に失敗したら印を付けない', async () => {
    const { deps, marked } = createHarness({
      create: async () => {
        throw new Error('422 label does not exist');
      },
    });

    await expect(createIssueFromMessage(deps, input())).rejects.toThrow(/422/);
    expect(marked).toHaveLength(0);
  });
});
