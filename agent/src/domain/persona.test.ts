import { describe, expect, it } from 'vitest';
import {
  composePersonaPrompt,
  type PersonaDiff,
  type PersonaProfile,
} from './persona.ts';

const profile: PersonaProfile = {
  assistantName: 'やち',
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

  // **食い違ったときに勝つのは差分**（→ D-12 の追記）。並べるだけだと、
  // 「性格」「話し方」という見出しのほうが強く読まれて、あとから頼んだ
  // 変更が効かない（実機で観測）。
  it('差分が静的設定より優先すると明示する', () => {
    const prompt = composePersonaPrompt({
      profile,
      diffs: [diff],
      locked: false,
    });
    const settingsAt = prompt.indexOf('ですます調');
    const diffAt = prompt.indexOf('専門用語は英語のまま使う。');
    expect(settingsAt).toBeLessThan(diffAt);
    expect(prompt).toContain('食い違う場合は、必ずこちらに従ってください。');
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
