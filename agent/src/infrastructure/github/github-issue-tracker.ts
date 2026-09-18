import type { IssueTracker } from '../../domain/ports/issue-tracker.ts';

const API_BASE = 'https://api.github.com';

export interface GithubIssueTrackerOptions {
  token: string;
  /** テスト用の差し替え口。既定は global の fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * GitHub の Issue API（F-37）。
 *
 * **失敗はそのまま投げる。** 無いラベルを送ると 422 が返るが、勝手に
 * ラベルを落として立て直さない —— 落とした事実は誰にも見えず、意図した
 * 分類と違う Issue だけが残る。API のメッセージを添えて上へ返し、
 * 呼んだ人に見せる。
 */
export function createGithubIssueTracker(
  options: GithubIssueTrackerOptions,
): IssueTracker {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async create(repository, draft) {
      const response = await doFetch(`${API_BASE}/repos/${repository}/issues`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: draft.title,
          body: draft.body,
          labels: [...draft.labels],
        }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `GitHub への起票に失敗しました（${response.status} ${repository}）: ${text.slice(0, 500)}`,
        );
      }

      const payload = JSON.parse(text) as {
        number?: number;
        html_url?: string;
      };
      if (typeof payload.number !== 'number' || !payload.html_url) {
        throw new Error(
          `GitHub の応答に issue の番号か URL がありません（${repository}）: ${text.slice(0, 200)}`,
        );
      }
      return { number: payload.number, url: payload.html_url };
    },
  };
}
