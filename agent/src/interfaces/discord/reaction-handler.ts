import { type Client, Events } from 'discord.js';
import { decideSkillByReaction } from '../../application/skill.ts';
import { skillDependencies } from '../../composition-root.ts';
import { logger } from '../../observability/logger.ts';

/**
 * 承認のリアクションを受ける（F-44）。
 *
 * **踏めるのは見える人なら誰でも**（オーナー判断）。スキルは全体でひとつ
 * （→ D-35）なので、共有チャンネルでは**会話に関わっていない人でも全員の
 * 人格・知識を変えられる。** だから誰が踏んだかは必ずログに残す。
 *
 * **自分のリアクションは無視する。** 問いかけを出すときに ✅ と ❌ を先に
 * 付けている（押せることを見せるため）ので、弾かないと**出した瞬間に
 * 自分で承認する。**
 */
export function registerReactionHandler(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void (async () => {
      try {
        if (user.bot) return;
        // 数分後・数日後に押される。そのころにはキャッシュに無いので、
        // partial のまま届く（→ gateway.ts の Partials）。
        if (reaction.partial) await reaction.fetch();

        const emoji = reaction.emoji.name;
        if (!emoji) return;

        const outcome = await decideSkillByReaction(skillDependencies, {
          channelId: reaction.message.channelId,
          messageId: reaction.message.id,
          emoji,
          userId: user.id,
          userName: user.username ?? user.id,
        });

        // 承認の問いかけ以外への絵文字は**普通に起こる**。黙って流す。
        if (outcome.kind === 'unrelated') return;
        if (outcome.kind === 'already-decided') {
          logger.debug(
            { skillId: outcome.candidate.id, status: outcome.candidate.status },
            'A reaction arrived for an already decided skill',
          );
        }
      } catch (error) {
        // リアクション 1 つの失敗で Gateway の購読ごと落とさない。
        logger.error(
          { err: error },
          'Failed to handle a reaction on an approval prompt',
        );
      }
    })();
  });
}
