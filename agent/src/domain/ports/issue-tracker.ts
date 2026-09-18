import type { CreatedIssue, IssueDraft } from '../issue.ts';

/**
 * Issue を立てる先（F-37）。GitHub 以外へ替える余地を残すため、
 * リポジトリは `owner/name` の文字列で受ける。
 *
 * 立てられなければ例外を投げる。ラベルが無い・権限が足りないといった
 * 理由は API のメッセージにしか無いので、握り潰さずそのまま上へ返す。
 */
export interface IssueTracker {
  create(repository: string, draft: IssueDraft): Promise<CreatedIssue>;
}
