import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { SkillStore } from '../domain/ports/skill-store.ts';
import {
  assertValidSkillProposal,
  mountableKinds,
  type SkillCandidate,
  type SkillProposal,
  type SkillStatus,
} from '../domain/skill.ts';

export interface SkillDependencies {
  store: SkillStore;
  /** 固定モード（F-34）の判定に読む。書き込みはしない（INV-9）。 */
  settings: SettingsProvider;
  log: {
    info(context: Record<string, unknown>, message: string): void;
    debug(context: Record<string, unknown>, message: string): void;
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
