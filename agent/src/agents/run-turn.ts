import { type DeliveredMessageInput, init } from '@flue/runtime';
import type { TenantId } from '../domain/tenant.ts';
import { dispatchSkillCurator } from './dispatch-curator.ts';
import { Yachi } from './yachi.agent.ts';

export interface AgentTurnInput {
  tenantId: TenantId;
  message: DeliveredMessageInput;
}

/** 会話として渡された本文。キュレーターへ材料として回すために取り出す。 */
function bodyOf(message: DeliveredMessageInput): string {
  if (typeof message === 'string') return message;
  return typeof message.body === 'string' ? message.body : '';
}

/**
 * どの入口（Discord、デバッグ用 HTTP、将来の Slack）も必ずここを通す。
 *
 * 入口ごとの関心事（署名検証・応答判定・返信の送り方）は呼び出し側に残し、
 * この関数はテナントのエージェントインスタンスへ渡して返事を読むだけにする。
 *
 * 長期記憶への書き出しはここでは行わない。記録は明示的なツール呼び出し
 * だけを経路にする（F-30）。
 *
 * **返信が確定したらキュレーターを起こす**（F-40）。入口ごとに書くのではなく
 * ここに置くのは、どの入口も同じようにスキルが育ってほしいから。
 */
export async function runAgentTurn(
  input: AgentTurnInput,
): Promise<string | undefined> {
  const handle = init(Yachi, { id: input.tenantId });
  const receipt = await handle.dispatch({ message: input.message });
  const reply = await handle.read(receipt);
  const text = reply.text.trim();
  if (text === '') return undefined;

  // fire-and-forget。待たないので応答レイテンシには影響しない。
  dispatchSkillCurator({
    tenantId: input.tenantId,
    userText: bodyOf(input.message),
    replyText: text,
  });

  return text;
}
