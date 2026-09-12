import { describe, expect, it } from 'vitest';
import {
  assertValidSkillProposal,
  mountableKinds,
  type SkillProposal,
} from './skill.ts';

function proposal(overrides: Partial<SkillProposal> = {}): SkillProposal {
  return {
    name: 'reply-in-short-sentences',
    description: '長くなりそうなときに短く区切って答える',
    instructions: '1 文を 40 文字以内にする。',
    kind: 'knowledge',
    ...overrides,
  };
}

describe('assertValidSkillProposal', () => {
  it('Flue のスキル名の形なら通る', () => {
    expect(() => assertValidSkillProposal(proposal())).not.toThrow();
    expect(() =>
      assertValidSkillProposal(proposal({ name: 'a1' })),
    ).not.toThrow();
  });

  // 承認まで通してから defineSkill に蹴られると、承認操作か毎ターンの
  // render が壊れる。候補生成の時点で落とす。
  it('Flue が受け取れない名前は候補の時点で落とす', () => {
    for (const name of [
      'Reply-Short',
      'reply_short',
      'reply--short',
      '-reply',
      'reply-',
      'リマインダー',
      '',
    ]) {
      expect(() => assertValidSkillProposal(proposal({ name }))).toThrow();
    }
  });

  it('名前は 64 文字まで', () => {
    expect(() =>
      assertValidSkillProposal(proposal({ name: 'a'.repeat(64) })),
    ).not.toThrow();
    expect(() =>
      assertValidSkillProposal(proposal({ name: 'a'.repeat(65) })),
    ).toThrow(/長すぎます/);
  });

  it('description と instructions は空を許さない', () => {
    expect(() =>
      assertValidSkillProposal(proposal({ description: '  ' })),
    ).toThrow(/description/);
    expect(() =>
      assertValidSkillProposal(proposal({ instructions: '' })),
    ).toThrow(/instructions/);
  });
});

describe('mountableKinds', () => {
  it('固定モードでは人格に関わる種別を外す（Q-16）', () => {
    expect(mountableKinds(true)).toEqual(['knowledge']);
  });

  it('固定モードでなければ両方載せる', () => {
    expect(mountableKinds(false)).toEqual(['knowledge', 'persona']);
  });
});
