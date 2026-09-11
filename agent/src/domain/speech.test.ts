import { describe, expect, it } from 'vitest';
import { splitIntoSentences } from './speech.ts';

describe('splitIntoSentences', () => {
  it('句点・感嘆符で区切り、区切り文字を残す', () => {
    expect(splitIntoSentences('こんにちは。元気ですか？はい！')).toEqual([
      'こんにちは。',
      '元気ですか？',
      'はい！',
    ]);
  });

  it('改行も文の区切りとして扱う', () => {
    expect(splitIntoSentences('一行目\n二行目')).toEqual(['一行目', '二行目']);
  });

  it('空行と余分な空白を落とす', () => {
    expect(splitIntoSentences('  あ。 \n\n  い。  ')).toEqual(['あ。', 'い。']);
  });

  it('句点の無い長文を読点で切る', () => {
    const long = `${'あ'.repeat(60)}、${'い'.repeat(80)}`;
    const parts = splitIntoSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe(`${'あ'.repeat(60)}、`);
    expect(parts.join('')).toBe(long);
  });

  it('読点も無い長文は強制的に切る', () => {
    const long = 'あ'.repeat(250);
    const parts = splitIntoSentences(long);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toBe(long);
  });

  it('空文字からは何も出さない', () => {
    expect(splitIntoSentences('   \n  ')).toEqual([]);
  });
});
