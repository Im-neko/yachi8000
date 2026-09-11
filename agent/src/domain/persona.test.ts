import { describe, expect, it } from 'vitest';
import {
  composePersonaPrompt,
  type PersonaDiff,
  type PersonaProfile,
} from './persona.ts';

const profile: PersonaProfile = {
  assistantName: 'やち',
  userAddress: 'あなた',
  firstPerson: 'わたし',
  personality: 'おだやかで、頼まれたことは最後までやり切る。',
  speechStyle: 'ですます調。語尾を伸ばさない。',
};

const diff: PersonaDiff = {
  id: 'diff-1',
  recordedAt: '2026-09-11T00:00:00Z',
  instruction: '専門用語は英語のまま使う。',
  reason: '利用者が訳語を嫌ったため',
};

describe('composePersonaPrompt', () => {
  it('静的設定を人格として出力する', () => {
    const prompt = composePersonaPrompt({ profile, diffs: [], locked: false });
    expect(prompt).toContain('やち');
    expect(prompt).toContain('わたし');
    expect(prompt).toContain('ですます調');
  });

  it('固定モードでないときは差分を追記する', () => {
    const prompt = composePersonaPrompt({
      profile,
      diffs: [diff],
      locked: false,
    });
    expect(prompt).toContain('専門用語は英語のまま使う。');
  });

  it('固定モードでは先頭に変更禁止の指示が入る', () => {
    const prompt = composePersonaPrompt({ profile, diffs: [], locked: true });
    expect(prompt.startsWith('# 最優先の指示（変更不可）')).toBe(true);
  });

  it('固定モードで差分を渡したら落とす（読んではいけない）', () => {
    expect(() =>
      composePersonaPrompt({ profile, diffs: [diff], locked: true }),
    ).toThrow(/固定モード/);
  });
});
