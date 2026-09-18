import {
  buildIssueBody,
  type CreatedIssue,
  type IssueSource,
  repositoryForChannel,
} from '../domain/issue.ts';
import type { IssueTracker } from '../domain/ports/issue-tracker.ts';
import type { MessageMarker } from '../domain/ports/message-marker.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';

export interface IssueDependencies {
  tracker: IssueTracker;
  settings: SettingsProvider;
  marker: MessageMarker;
  log: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}

export interface CreateIssueInput {
  /** 起票先を決めるチャンネル。スレッドではなく**親チャンネル**の ID。 */
  channelId: string;
  /** 出典になった投稿（＝スレッドの元投稿）。 */
  source: IssueSource;
  /** 印を付ける相手。元投稿と同じ。 */
  sourceMessageId: string;
  title: string;
  body: string;
  labels: readonly string[];
  /** メンションで言われたこと。 */
  instruction: string;
}

/**
 * チャットの投稿から Issue を立てる（F-37）。
 *
 * 起票のあとに印（✅）を付ける。**順序を逆にしない** —— 印だけが残って
 * Issue が無い状態は、夜の棚卸し（stocktrade の memo-triage）からも
 * 人の目からも見えなくなる。逆に Issue だけ立って印が無いのは、棚卸しが
 * 出典リンクで気付けるので回復できる。
 *
 * 印を付けられなかったことで会話を止めない。Issue は立っているので、
 * 利用者へ返す答えはそのまま返し、付かなかった事実はログへ残す。
 */
export async function createIssueFromMessage(
  deps: IssueDependencies,
  input: CreateIssueInput,
): Promise<CreatedIssue> {
  const repository = repositoryForChannel(deps.settings.get(), input.channelId);
  if (!repository) {
    throw new Error(
      'このチャンネルには Issue の起票先が設定されていません。設定ファイルの issueTracker.repositories にチャンネルとリポジトリの対応を書いてください。',
    );
  }

  const title = input.title.trim();
  if (title === '') {
    throw new Error('Issue のタイトルが空です。');
  }

  const created = await deps.tracker.create(repository, {
    title,
    body: buildIssueBody({
      source: input.source,
      instruction: input.instruction,
      body: input.body,
    }),
    labels: input.labels,
  });

  try {
    await deps.marker.markHandled(input.channelId, input.sourceMessageId);
  } catch (error) {
    deps.log.warn(
      {
        err: error,
        channelId: input.channelId,
        messageId: input.sourceMessageId,
        issue: created.number,
      },
      'Created the issue but could not mark the source message — the nightly triage may pick it up again',
    );
  }

  return created;
}
