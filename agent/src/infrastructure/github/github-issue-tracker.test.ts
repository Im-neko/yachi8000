import { describe, expect, it } from 'vitest';
import { createGithubIssueTracker } from './github-issue-tracker.ts';

const DRAFT = { title: 'タイトル', body: '本文', labels: ['idea'] };

describe('createGithubIssueTracker', () => {
  it('番号と URL を返す', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const tracker = createGithubIssueTracker({
      token: 'tok',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(
          JSON.stringify({
            number: 1357,
            html_url: 'https://github.com/o/r/issues/1357',
          }),
          { status: 201 },
        );
      }) as unknown as typeof fetch,
    });

    const issue = await tracker.create('o/r', DRAFT);

    expect(issue).toEqual({
      number: 1357,
      url: 'https://github.com/o/r/issues/1357',
    });
    expect(seen?.url).toBe('https://api.github.com/repos/o/r/issues');
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      title: 'タイトル',
      body: '本文',
      labels: ['idea'],
    });
  });

  it('失敗したら本文を添えて投げる（ラベルを落として立て直さない）', async () => {
    const tracker = createGithubIssueTracker({
      token: 'tok',
      fetchImpl: (async () =>
        new Response('{"message":"Validation Failed"}', {
          status: 422,
        })) as unknown as typeof fetch,
    });

    await expect(tracker.create('o/r', DRAFT)).rejects.toThrow(
      /422 o\/r.*Validation Failed/s,
    );
  });

  it('2xx でも番号が無ければ失敗として扱う', async () => {
    const tracker = createGithubIssueTracker({
      token: 'tok',
      fetchImpl: (async () =>
        new Response('{"ok":true}', {
          status: 201,
        })) as unknown as typeof fetch,
    });

    await expect(tracker.create('o/r', DRAFT)).rejects.toThrow(/番号/);
  });
});
