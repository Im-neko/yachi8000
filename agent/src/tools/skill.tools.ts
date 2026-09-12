import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { listSkills, proposeSkill } from '../application/skill.ts';
import { skillDependencies } from '../composition-root.ts';
import type { SkillCandidate } from '../domain/skill.ts';
import type { TenantId } from '../domain/tenant.ts';

export interface SkillCuratorToolsContext {
  tenantId: TenantId;
}

function formatCandidate(candidate: SkillCandidate): string {
  return `- ${candidate.name} [${candidate.status}/${candidate.kind}] ${candidate.description}`;
}

/**
 * キュレーターエージェント（F-40）が使うツール。
 *
 * **キュレーターは提案しかできない。** 承認・却下は人の操作（スラッシュ
 * コマンド）で、ここには生やさない（絶対ルール 4, F-41）。
 *
 * LLM は分類と要約だけをして、書き込みは受け取った構造化された結果を
 * 決定的なコードが行う（INV-3）。
 */
export function createSkillCuratorTools(ctx: SkillCuratorToolsContext) {
  const list = defineTool({
    name: 'list_skills',
    description:
      'このテナントに既にあるスキル（承認済み・保留中・却下済み・無効化済み）を一覧します。' +
      '**提案の前に必ず呼んでください。** 却下された名前も名前を占有しているので、同じ名前では登録できません。',
    input: v.object({}),
    run() {
      const skills = listSkills(skillDependencies, ctx.tenantId, [
        'pending',
        'approved',
        'rejected',
        'disabled',
      ]);
      if (skills.length === 0) return 'まだスキルはありません。';
      return skills.map(formatCandidate).join('\n');
    },
  });

  const propose = defineTool({
    name: 'propose_skill',
    description:
      '再利用できる知見をスキル候補として登録します。承認されるまで応答には反映されません。' +
      '毎回登録しようとせず、**後のやり取りでも繰り返し効く知見だけ**にしてください。既存のスキルと重なるなら登録しません。' +
      'kind は、話し方・性格・呼称・口調に関わるなら persona、手順・知識・事実に関わるなら knowledge です。' +
      '**どちらとも言えるときは persona にしてください**（人格を固定している利用者の設定を、手順スキルのふりをして越えないため）。',
    input: v.object({
      name: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(64),
        v.regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          '英小文字と数字をハイフン 1 つでつないだ形にしてください（例: reply-in-short-sentences）。',
        ),
      ),
      description: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
      instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
      kind: v.picklist(['knowledge', 'persona']),
    }),
    run({ data }) {
      const candidate = proposeSkill(skillDependencies, {
        tenantId: ctx.tenantId,
        name: data.name,
        description: data.description,
        instructions: data.instructions,
        kind: data.kind,
      });
      return `スキル候補 "${candidate.name}" を保留中として記録しました。承認されるまで応答には使われません。`;
    },
  });

  return [list, propose];
}
