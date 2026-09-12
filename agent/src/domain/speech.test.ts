import { describe, expect, it } from 'vitest';
import { splitIntoSentences, stripUrlsForSpeech } from './speech.ts';

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

describe('stripUrlsForSpeech', () => {
  it('URL を「リンク」に置き換える', () => {
    expect(
      stripUrlsForSpeech('詳しくは https://example.com/a/b?c=d を見て'),
    ).toBe('詳しくは リンク を見て');
  });

  it('句読点は URL に含めない（文の切れ目を消さない）', () => {
    expect(stripUrlsForSpeech('できました。https://example.com/pr/1。')).toBe(
      'できました。リンク。',
    );
    expect(
      splitIntoSentences(stripUrlsForSpeech('done。https://x.test/a。')),
    ).toEqual(['done。', 'リンク。']);
  });

  it('Markdown のリンクは表示文字列を残す', () => {
    expect(
      stripUrlsForSpeech(
        '[議事録](https://example.com/notes) を置いておきます',
      ),
    ).toBe('議事録 を置いておきます');
  });

  it('Discord の <> 付き URL も落とす', () => {
    expect(stripUrlsForSpeech('<https://example.com/x> です')).toBe(
      'リンク です',
    );
  });

  it('www. から始まるものも URL として扱う', () => {
    expect(stripUrlsForSpeech('www.example.com が出典です')).toBe(
      'リンク が出典です',
    );
  });

  it('複数あってもすべて置き換える', () => {
    expect(stripUrlsForSpeech('https://a.test と https://b.test')).toBe(
      'リンク と リンク',
    );
  });

  it('本文が URL だけでも無音にならない', () => {
    expect(
      splitIntoSentences(stripUrlsForSpeech('https://example.com')),
    ).toEqual(['リンク']);
  });

  // スキーム無しのドメインまで拾うと普通の語を巻き込む。読み落とすほうが、
  // 読むべき語を消すより害が小さい。
  it('スキームの無い語は URL として扱わない', () => {
    expect(stripUrlsForSpeech('Node.js の v1.2 で example.com 相当の話')).toBe(
      'Node.js の v1.2 で example.com 相当の話',
    );
  });

  it('Discord のメンションや絵文字を壊さない', () => {
    expect(stripUrlsForSpeech('<@123456> さん <:neko:987> だよ')).toBe(
      '<@123456> さん <:neko:987> だよ',
    );
  });

  it('URL が無ければ何も変えない', () => {
    expect(stripUrlsForSpeech('ふつうの文です。')).toBe('ふつうの文です。');
  });
});
