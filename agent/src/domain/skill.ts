import type { TenantId } from './tenant.ts';

/**
 * スキル候補の種別（→ Q-16 の決定）。
 *
 * 固定モード（F-34）は「人格に関わるものを読まない」という 1 つの規則で
 * 成り立っている。人格差分と同じ扱いにするため、スキルも人格に関わるか
 * どうかを**候補生成時に構造として持つ**。キュレーターの判定に迷いが
 * あれば `persona` 側へ倒す（安全側）。
 */
export type SkillKind = 'knowledge' | 'persona';

/**
 * スキル候補の状態（F-41, F-43）。
 *
 * ```
 * pending ──approve──▶ approved ──disable──▶ disabled
 *    │                     ▲                    │
 *    └──reject──▶ rejected └────────enable──────┘
 * ```
 *
 * - `pending` のものは**応答に一切反映されない**（絶対ルール 4, F-41）
 * - `rejected` は行として残す。消すとキュレーターが同じ名前を出し直す
 * - `disabled` は「効かなくなったスキルの無効化」（F-43）。再度有効化できる
 */
export type SkillStatus = 'pending' | 'approved' | 'rejected' | 'disabled';

export interface SkillCandidate {
  id: string;
  tenantId: TenantId;
  /** Flue のスキル名。テナント内で一意。 */
  name: string;
  /** カタログ行。モデルが「いつ使うか」を決める手掛かり。 */
  description: string;
  /** 有効化時に読み込まれる本文。 */
  instructions: string;
  kind: SkillKind;
  status: SkillStatus;
  proposedAt: string;
  /** 承認・却下・無効化した時刻。未決なら undefined。 */
  decidedAt: string | undefined;
}

/**
 * Flue の `defineSkill()` が課す制約（`@flue/runtime` 2.0.3 の実装を確認）。
 *
 * **候補生成の時点で落とす。** 承認まで通してから `defineSkill()` に投げられる
 * と、承認操作が失敗するか、最悪 render で毎ターン落ちる（そのテナントの
 * エージェントが会話できなくなる）。
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillProposal {
  name: string;
  description: string;
  instructions: string;
  kind: SkillKind;
}

/** 候補が Flue のスキルとして成立するかを検査する。通らなければ投げる。 */
export function assertValidSkillProposal(proposal: SkillProposal): void {
  const name = proposal.name.trim();
  if (name === '') {
    throw new Error('スキル名が空です。');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `スキル名が長すぎます（${name.length} 文字）。${MAX_NAME_LENGTH} 文字までです。`,
    );
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `スキル名 "${name}" は使えません。英小文字・数字をハイフン 1 つでつないだ形にしてください（例: reply-in-short-sentences）。`,
    );
  }
  if (proposal.description.trim() === '') {
    throw new Error(
      'スキルの description が空です。いつ使うかを書いてください。',
    );
  }
  if ([...proposal.description].length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `スキルの description が長すぎます。${MAX_DESCRIPTION_LENGTH} 文字までです。`,
    );
  }
  if (proposal.instructions.trim() === '') {
    throw new Error('スキルの instructions が空です。');
  }
}

/**
 * 固定モード（F-34）で応答に載せてよい種別（→ Q-16 の決定）。
 *
 * 固定モードは人格差分を読まないことで成り立っている。人格に関わるスキルを
 * マウントすると、同じ変化が別の入口から入ってきて防御が抜ける。
 */
export function mountableKinds(personaLocked: boolean): readonly SkillKind[] {
  return personaLocked ? ['knowledge'] : ['knowledge', 'persona'];
}
