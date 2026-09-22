import {
  APPROVE_EMOJI,
  type ApprovalPrompt,
  REJECT_EMOJI,
} from '../domain/ports/approval-prompt.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { SkillStore } from '../domain/ports/skill-store.ts';
import {
  assertValidSkillProposal,
  mountableKinds,
  renderSkillApproval,
  renderSkillDecision,
  type SkillCandidate,
  type SkillProposal,
  type SkillStatus,
} from '../domain/skill.ts';

export interface SkillDependencies {
  store: SkillStore;
  /** 固定モード（F-34）の判定に読む。書き込みはしない（INV-9）。 */
  settings: SettingsProvider;
  /**
   * 承認をその場で聞く口（F-44）。**任意** —— 聞けなくても候補は残り、
   * `/skill` から承認できる。
   */
  prompt?: ApprovalPrompt;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    debug(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * スキル候補を記録する（F-40, F-41）。
 *
 * **pending として入る。** 承認されるまで応答に一切反映されない（絶対ルール 4）。
 * Flue のスキルとして成立しない候補はここで落とす —— 承認まで通してから
 * `defineSkill()` に蹴られると、承認操作か毎ターンの render が壊れる。
 */
export function proposeSkill(
  deps: SkillDependencies,
  input: SkillProposal,
): SkillCandidate {
  assertValidSkillProposal(input);
  const candidate = deps.store.propose(input);
  deps.log.info(
    {
      skillId: candidate.id,
      name: candidate.name,
      kind: candidate.kind,
    },
    'Recorded a skill candidate as pending',
  );
  return candidate;
}

/**
 * 提案したその場で承認を聞く（F-44）。**待たない。**
 *
 * キュレーターは返信確定後に fire-and-forget で走る（F-40）。ここで待つと、
 * 提案のたびに Discord の往復 3 回ぶん（投稿 + リアクション 2 つ）が
 * キュレーターのターンにぶら下がる。
 *
 * **聞けなくても候補は残る。** 聞くのは承認を楽にするためで、承認そのもの
 * ではない —— 失敗しても `/skill` から今までどおり承認できる（縮退なので
 * WARN には出す → INV-7）。
 */
export function askForSkillApproval(
  deps: SkillDependencies,
  candidate: SkillCandidate,
  channelId: string,
): void {
  const prompt = deps.prompt;
  if (!prompt) return;

  prompt
    .ask(channelId, renderSkillApproval(candidate))
    .then((messageId) => {
      deps.store.recordAsk(candidate.id, channelId, messageId);
      deps.log.info(
        { skillId: candidate.id, channelId, messageId },
        'Asked whether to keep the skill',
      );
    })
    .catch((error: unknown) => {
      deps.log.warn(
        { err: error, skillId: candidate.id, channelId },
        'Failed to ask for approval — the candidate is still pending',
      );
    });
}

/** リアクションで決まった結果。 */
export type SkillReactionOutcome =
  | { kind: 'decided'; candidate: SkillCandidate }
  /** その投稿は承認の問いかけではない。**普通に起こる**（ただの雑談への絵文字）。 */
  | { kind: 'unrelated' }
  /** 承認の問いかけだが、もう決まっている。 */
  | { kind: 'already-decided'; candidate: SkillCandidate };

/**
 * リアクションで承認・否認する（F-44）。
 *
 * **踏めるのは見える人なら誰でも**（オーナー判断）。スキルは全体でひとつ
 * （→ D-35）なので、**踏んだ人の判断が全員に効く。** だから誰が踏んだかは
 * 必ずログに残す —— あとから「いつ誰が変えたか」を辿れるようにする。
 */
export async function decideSkillByReaction(
  deps: SkillDependencies,
  input: {
    channelId: string;
    messageId: string;
    emoji: string;
    userId: string;
    userName: string;
  },
): Promise<SkillReactionOutcome> {
  if (input.emoji !== APPROVE_EMOJI && input.emoji !== REJECT_EMOJI) {
    return { kind: 'unrelated' };
  }

  const candidate = deps.store.findByAsk(input.channelId, input.messageId);
  if (!candidate) return { kind: 'unrelated' };
  if (candidate.status !== 'pending') {
    return { kind: 'already-decided', candidate };
  }

  const decided =
    input.emoji === APPROVE_EMOJI
      ? approveSkill(deps, candidate.id)
      : rejectSkill(deps, candidate.id);
  if (!decided) return { kind: 'already-decided', candidate };

  deps.log.info(
    {
      skillId: decided.id,
      name: decided.name,
      status: decided.status,
      decidedBy: input.userId,
    },
    'Decided a skill by reaction',
  );

  // **問いかけのまま残さない。** 過去ログを遡った人が決着済みの問いを
  // もう一度押すことになる。**書き換えに失敗しても決定は覆さない。**
  try {
    await deps.prompt?.settle(
      input.channelId,
      input.messageId,
      renderSkillDecision(decided, input.userName),
    );
  } catch (error) {
    deps.log.warn(
      { err: error, skillId: decided.id },
      'Decided the skill but could not rewrite the message',
    );
  }

  return { kind: 'decided', candidate: decided };
}

export function listSkills(
  deps: SkillDependencies,
  statuses: readonly SkillStatus[],
): readonly SkillCandidate[] {
  return deps.store.list(statuses);
}

/**
 * 承認する（F-41）。**次のターン以降に効く。** 承認したその場の返信には
 * 反映されない（render はターンの入口で 1 度だけ組み立てられる）。
 */
export function approveSkill(
  deps: SkillDependencies,
  id: string,
): SkillCandidate | undefined {
  const approved = deps.store.transition(
    id,
    ['pending', 'disabled'],
    'approved',
  );
  if (approved) {
    deps.log.info(
      { skillId: approved.id, name: approved.name },
      'Approved a skill',
    );
  }
  return approved;
}

export function rejectSkill(
  deps: SkillDependencies,
  id: string,
): SkillCandidate | undefined {
  const rejected = deps.store.transition(id, ['pending'], 'rejected');
  if (rejected) {
    deps.log.info(
      { skillId: rejected.id, name: rejected.name },
      'Rejected a skill candidate',
    );
  }
  return rejected;
}

/**
 * pending の一括却下（F-43）。
 *
 * **実行時点で pending だった行だけを動かす。** 途中で届いた提案は残る
 * （キュレーターは fire-and-forget なので、いつ届くかは制御できない）。
 */
export function rejectAllPendingSkills(deps: SkillDependencies): number {
  const rejected = deps.store.rejectAllPending();
  deps.log.info({ rejected }, 'Rejected every pending skill candidate');
  return rejected;
}

/** 効かなくなったスキルの無効化（F-43）。承認し直せば戻る。 */
export function disableSkill(
  deps: SkillDependencies,
  id: string,
): SkillCandidate | undefined {
  const disabled = deps.store.transition(id, ['approved'], 'disabled');
  if (disabled) {
    deps.log.info(
      { skillId: disabled.id, name: disabled.name },
      'Disabled a skill',
    );
  }
  return disabled;
}

/**
 * 応答へマウントする対象（F-42）。
 *
 * 固定モード（F-34）では**人格に関わる種別を外す**（→ Q-16 の決定）。差分を
 * 読まないだけでは、同じ変化がスキルという別の入口から入ってきてしまう。
 */
export function mountableSkills(
  deps: SkillDependencies,
): readonly SkillCandidate[] {
  const locked = deps.settings.get().behavior.personaLock;
  const kinds = mountableKinds(locked);
  const skills = deps.store.mountable(kinds);
  if (locked) {
    deps.log.debug(
      { mounted: skills.length },
      'Persona lock is on — persona-kind skills are not mounted',
    );
  }
  return skills;
}
