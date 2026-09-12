import type { PersonaDiff } from '../domain/persona.ts';
import { composePersonaPrompt } from '../domain/persona.ts';
import type {
  PersonaDiffRecord,
  PersonaDiffStore,
} from '../domain/ports/persona-diff-store.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import { personaProfileOf } from '../domain/settings.ts';
import type { TenantId } from '../domain/tenant.ts';

/** 履歴として見せる最大件数。 */
const HISTORY_LIMIT = 30;

export interface PersonaDependencies {
  settings: SettingsProvider;
  diffs: PersonaDiffStore;
  log: {
    info(context: Record<string, unknown>, message: string): void;
  };
}

/**
 * 応答に使う人格を組み立てる（F-32）。
 *
 * 固定モード（F-34）では差分ストアを**呼ばない**。読んでから捨てるのでは
 * なく読まないことが、D-13 でいう決定的な防御そのもの。
 */
export function buildPersonaPrompt(
  deps: PersonaDependencies,
  tenantId: TenantId,
): string {
  const settings = deps.settings.get();
  const locked = settings.behavior.personaLock;
  const diffs = locked ? [] : deps.diffs.list(tenantId);
  return composePersonaPrompt({
    profile: personaProfileOf(settings),
    diffs,
    locked,
  });
}

/** 固定モードが有効か。ツールが「今は効かない」と伝えるために読む。 */
export function isPersonaLocked(deps: PersonaDependencies): boolean {
  return deps.settings.get().behavior.personaLock;
}

/**
 * 人格の変化を記録する（F-33）。
 *
 * **固定モードでも記録は止めない**（D-13）。止めてしまうと OFF に戻したときに
 * 「元の続きから再開できる」が成立しない。適用するかどうかは読み出し側
 * （`buildPersonaPrompt`）の判断で、ここは常に書く。
 */
export function recordPersonaChange(
  deps: PersonaDependencies,
  input: { tenantId: TenantId; instruction: string; reason: string },
): PersonaDiff {
  const instruction = input.instruction.trim();
  const reason = input.reason.trim();
  if (instruction === '') {
    throw new Error('人格の変化として空の指示は記録できません。');
  }
  if (reason === '') {
    throw new Error(
      '人格の変化には契機（何があってそうなったか）が必要です（F-33）。',
    );
  }

  const diff = deps.diffs.record({
    tenantId: input.tenantId,
    instruction,
    reason,
  });
  deps.log.info(
    {
      tenantId: input.tenantId,
      diffId: diff.id,
      applied: !isPersonaLocked(deps),
    },
    'Recorded a persona change',
  );
  return diff;
}

/** 変化の一覧（F-33）。巻き戻し済みのものも含める。 */
export function listPersonaChanges(
  deps: PersonaDependencies,
  tenantId: TenantId,
): readonly PersonaDiffRecord[] {
  return deps.diffs.history(tenantId, HISTORY_LIMIT);
}

/** 個別の巻き戻し（F-33）。 */
export function revertPersonaChange(
  deps: PersonaDependencies,
  input: { tenantId: TenantId; id: string },
): boolean {
  const reverted = deps.diffs.revert(input.tenantId, input.id);
  if (reverted) {
    deps.log.info(
      { tenantId: input.tenantId, diffId: input.id },
      'Reverted a persona change',
    );
  }
  return reverted;
}

/** 既定の人格までの一括巻き戻し（F-33）。設定ファイルには触らない（INV-9）。 */
export function resetPersona(
  deps: PersonaDependencies,
  tenantId: TenantId,
): number {
  const reverted = deps.diffs.revertAll(tenantId);
  deps.log.info(
    { tenantId, reverted },
    'Reset the persona to the settings file',
  );
  return reverted;
}
