import { describe, expect, it } from 'vitest';
import { splitForDiscord } from './outgoing.ts';

describe('splitForDiscord', () => {
  it('上限以下ならそのまま 1 通', () => {
    expect(splitForDiscord('こんにちは')).toEqual(['こんにちは']);
  });

  it('どの塊も上限を超えない', () => {
    const text = 'あ'.repeat(5000);
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('')).toBe(text);
  });

  it('改行があればそこで切る', () => {
    expect(splitForDiscord('あいう\nえお', 4)).toEqual(['あいう', 'えお']);
  });

  it('改行が無ければ空白で切る', () => {
    expect(splitForDiscord('あいう えお', 4)).toEqual(['あいう', 'えお']);
  });

  it('区切りが無ければ長さで切る', () => {
    expect(splitForDiscord('あいうえお', 2)).toEqual(['あい', 'うえ', 'お']);
  });

  it('空文字は 1 通も作らない', () => {
    expect(splitForDiscord('   ')).toEqual([]);
  });
});
