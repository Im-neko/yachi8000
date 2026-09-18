import { describe, expect, it } from 'vitest';
import {
  buildIssueBody,
  type IssueSource,
  repositoryForChannel,
} from './issue.ts';
import type { Settings } from './settings.ts';

const SOURCE: IssueSource = {
  url: 'https://discord.com/channels/1/2/3',
  postedOn: '2026-09-18',
  text: '日次の取引バリデータを作りたい。\ntick から約定可能性を検証する。',
};

function settingsWith(
  repositories: Record<string, string> | undefined,
): Settings {
  return (repositories
    ? { issueTracker: { repositories } }
    : {}) as unknown as Settings;
}

describe('repositoryForChannel', () => {
  it('設定されたチャンネルのリポジトリを返す', () => {
    const settings = settingsWith({ '2': 'Im-neko/stocktrade' });
    expect(repositoryForChannel(settings, '2')).toBe('Im-neko/stocktrade');
  });

  it('設定に無いチャンネルでは undefined を返す（既定のリポジトリへ倒さない）', () => {
    const settings = settingsWith({ '2': 'Im-neko/stocktrade' });
    expect(repositoryForChannel(settings, '999')).toBeUndefined();
  });

  it('issueTracker 自体が無くても落ちない', () => {
    expect(repositoryForChannel(settingsWith(undefined), '2')).toBeUndefined();
  });
});

describe('buildIssueBody', () => {
  it('出典リンクと元投稿の引用を先頭に置く', () => {
    const body = buildIssueBody({
      source: SOURCE,
      instruction: 'Issue にして',
      body: '## 完了条件\n突合レポートが出ること',
    });

    expect(body).toContain('## 出典');
    expect(body).toContain(
      'https://discord.com/channels/1/2/3（2026-09-18 投稿）',
    );
    expect(body).toContain('> 日次の取引バリデータを作りたい。');
    expect(body).toContain('> tick から約定可能性を検証する。');
    expect(body).toContain('## 依頼');
    expect(body).toContain('Issue にして');
    expect(body).toContain('突合レポートが出ること');
  });

  it('出典リンクは本文の先頭側にある（棚卸しの照合キーなので必ず入る）', () => {
    const body = buildIssueBody({
      source: SOURCE,
      instruction: 'これ起票して',
      body: '本文',
    });
    expect(body.indexOf(SOURCE.url)).toBeLessThan(body.indexOf('本文'));
  });

  it('長い元投稿は引用を切り詰める', () => {
    const body = buildIssueBody({
      source: { ...SOURCE, text: 'あ'.repeat(3000) },
      instruction: '起票して',
      body: '本文',
    });
    expect(body).toContain('…');
    expect(body.length).toBeLessThan(3000);
  });
});
