import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import type { SkillStore } from '../domain/ports/skill-store.ts';
import {
  assertValidSkillProposal,
  mountableKinds,
  type SkillCandidate,
  type SkillProposal,
  type SkillStatus,
} from '../domain/skill.ts';
import type { TenantId } from '../domain/tenant.ts';

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
  input: SkillProposal & { tenantId: TenantId },
): SkillCandidate {
  assertValidSkillProposal(input);
  const candidate = deps.store.propose(input);
  deps.log.info(
    {
      tenantId: candidate.tenantId,
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
  tenantId: TenantId,
  statuses: readonly SkillStatus[],
): readonly SkillCandidate[] {
  return deps.store.list(tenantId, statuses);
}

/**
 * 承認する（F-41）。**次のターン以降に効く。** 承認したその場の返信には
 * 反映されない（render はターンの入口で 1 度だけ組み立てられる）。
 */
export function approveSkill(
  deps: SkillDependencies,
  input: { tenantId: TenantId; id: string },
): SkillCandidate | undefined {
  const approved = deps.store.transition(
    input.tenantId,
    input.id,
    ['pending', 'disabled'],
    'approved',
  );
  if (approved) {
    deps.log.info(
      { tenantId: input.tenantId, skillId: approved.id, name: approved.name },
      'Approved a skill',
    );
  }
  return approved;
}

export function rejectSkill(
  deps: SkillDependencies,
  input: { tenantId: TenantId; id: string },
): SkillCandidate | undefined {
  const rejected = deps.store.transition(
    input.tenantId,
    input.id,
    ['pending'],
    'rejected',
  );
  if (rejected) {
    deps.log.info(
      { tenantId: input.tenantId, skillId: rejected.id, name: rejected.name },
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
export function rejectAllPendingSkills(
  deps: SkillDependencies,
  tenantId: TenantId,
): number {
  const rejected = deps.store.rejectAllPending(tenantId);
  deps.log.info(
    { tenantId, rejected },
    'Rejected every pending skill candidate',
  );
  return rejected;
}

/** 効かなくなったスキルの無効化（F-43）。承認し直せば戻る。 */
export function disableSkill(
  deps: SkillDependencies,
  input: { tenantId: TenantId; id: string },
): SkillCandidate | undefined {
  const disabled = deps.store.transition(
    input.tenantId,
    input.id,
    ['approved'],
    'disabled',
  );
  if (disabled) {
    deps.log.info(
      { tenantId: input.tenantId, skillId: disabled.id, name: disabled.name },
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
  tenantId: TenantId,
): readonly SkillCandidate[] {
  const locked = deps.settings.get().behavior.personaLock;
  const kinds = mountableKinds(locked);
  const skills = deps.store.mountable(tenantId, kinds);
  if (locked) {
    deps.log.debug(
      { tenantId, mounted: skills.length },
      'Persona lock is on — persona-kind skills are not mounted',
    );
  }
  return skills;
}
