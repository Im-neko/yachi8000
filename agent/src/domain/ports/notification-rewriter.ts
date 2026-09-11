import type { Notification } from '../notification.ts';

/**
 * 通知を自然な発話文へ書き換える（F-16）。
 *
 * LLM は文面の生成だけを行い、外部システムを操作しない（INV-3）。
 * 本文は非信頼データとして渡す（INV-4, F-19）。
 */
export interface NotificationRewriter {
  rewrite(notification: Notification): Promise<string>;
}
