import { type DeliveredMessageInput, init } from '@flue/runtime';
import { ensureSpeakerProfile } from '../application/person.ts';
import { avatarPresence, personDependencies } from '../composition-root.ts';
import type { ConversationId } from '../domain/conversation.ts';
import { parseSpeakerId } from '../domain/speaker.ts';
import { dispatchSkillCurator } from './dispatch-curator.ts';
import { Yachi } from './yachi.agent.ts';

export interface AgentTurnInput {
  conversationId: ConversationId;
  message: DeliveredMessageInput;
}

/** 会話として渡された本文。キュレーターへ材料として回すために取り出す。 */
function bodyOf(message: DeliveredMessageInput): string {
  if (typeof message === 'string') return message;
  return typeof message.body === 'string' ? message.body : '';
}

/**
 * 初対面の相手を覚える（F-05）。**入口ごとではなくここに置く。**
 *
 * どの入口も同じように相手を判別してほしいから。表示名が通らなければ
 * 登録しないだけで、会話は続く（application 側が WARN を出す）。
 */
function rememberSpeaker(message: DeliveredMessageInput): void {
  if (typeof message === 'string' || message.kind !== 'signal') return;
  const speakerId = parseSpeakerId(message.attributes?.speakerId);
  const displayName = message.attributes?.speakerName;
  if (!speakerId || typeof displayName !== 'string') return;
  ensureSpeakerProfile(personDependencies, { speakerId, displayName });
}

/**
 * どの入口（Discord、デバッグ用 HTTP）も必ずここを通す。
 *
 * 入口ごとの関心事（署名検証・応答判定・返信の送り方）は呼び出し側に残し、
 * この関数はその会話のエージェントインスタンスへ渡して返事を読むだけにする。
 *
 * **`conversationId` が分けるのは短中期の会話文脈だけ**（→ D-35）。長期記憶・
 * 人格・スキル・リマインダーは全体でひとつの入れ物にあり、「誰の話か」は
 * 話者 ID（F-05）が持つ。
 *
 * 長期記憶への書き出しはここでは行わない。記録は明示的なツール呼び出し
 * だけを経路にする（F-30）。
 *
 * **返信が確定したらキュレーターを起こす**（F-40）。入口ごとに書くのではなく
 * ここに置くのは、どの入口も同じようにスキルが育ってほしいから。
 *
 * **「考えている」の区間もここ**（F-22）。**読み上げと重なる** —— 前の発話が
 * まだ鳴っている最中に次のターンが始まることがあるので、どちらが強いかは
 * `avatarPresence` が決める。
 */
export async function runAgentTurn(
  input: AgentTurnInput,
): Promise<string | undefined> {
  rememberSpeaker(input.message);

  const endThinking = avatarPresence.beginThinking();
  let text: string;
  try {
    const handle = init(Yachi, { id: input.conversationId });
    const receipt = await handle.dispatch({ message: input.message });
    const reply = await handle.read(receipt);
    text = reply.text.trim();
  } finally {
    // 失敗しても必ず戻す。戻し忘れると「考えている」のまま固まる。
    endThinking();
  }
  if (text === '') return undefined;

  // fire-and-forget。待たないので応答レイテンシには影響しない。
  dispatchSkillCurator({
    conversationId: input.conversationId,
    userText: bodyOf(input.message),
    replyText: text,
  });

  return text;
}
