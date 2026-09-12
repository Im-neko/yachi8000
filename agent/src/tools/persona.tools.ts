import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  isPersonaLocked,
  recordPersonaChange,
} from '../application/persona.ts';
import { personaDependencies } from '../composition-root.ts';
import type { TenantId } from '../domain/tenant.ts';

export interface PersonaToolsContext {
  tenantId: TenantId;
}

/**
 * 会話を通じた人格の変化の記録（F-33）。
 *
 * 設定ファイル（静的設定）には**書かない**。書き込み先はランタイム状態の
 * 差分だけで、既定の人格は人が触るものとして残る（INV-8, INV-9, D-12）。
 *
 * 固定モード中も記録は続ける（D-13）。効いていないことはツールの戻り値で
 * 伝える —— 黙って記録だけすると、利用者は「言ったのに変わらない」だけを見る。
 */
export function createPersonaTools(ctx: PersonaToolsContext) {
  const record = defineTool({
    name: 'record_persona_change',
    description:
      '自分の話し方・性格の変化を、次のターン以降にも続くものとして記録します。' +
      '「これからはもっと砕けて話して」「その呼び方はやめて」のように、' +
      '**この先ずっとそうしてほしい**と頼まれたときだけ使ってください。' +
      'その場かぎりの指示（今回だけ短く答えて、など）には使いません。' +
      'instruction は自分への指示として書き、reason には利用者のどの発言が契機かを書いてください。',
    input: v.object({
      instruction: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    }),
    run({ data }) {
      const diff = recordPersonaChange(personaDependencies, {
        tenantId: ctx.tenantId,
        instruction: data.instruction,
        reason: data.reason,
      });
      if (isPersonaLocked(personaDependencies)) {
        return (
          `記録しました（ID: ${diff.id}）。ただし人格・口調の固定モードが有効なので、` +
          '今は応答に反映されません。設定で固定モードを解除すると効きはじめます。'
        );
      }
      return `記録しました（ID: ${diff.id}）。次のターンから反映されます。`;
    },
  });

  return [record];
}
