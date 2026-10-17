import { describe, expect, it, vi } from 'vitest';
import type {
  WikiEditor,
  WikiPage,
  WikiSource,
} from '../domain/ports/wiki-source.ts';
import {
  appendToWikiPage,
  assertWritablePath,
  createWikiPage,
  MAX_WIKI_WRITE_CHARS,
  replaceWikiPage,
} from './wiki.ts';

const PAGE: WikiPage = {
  path: 'infra/memo',
  title: 'メモ',
  description: '',
  locale: 'ja',
  content: '# メモ\n\n既存の本文\n',
  updatedAt: '2026-10-17T00:00:00.000Z',
};

function setup(current: WikiPage | null = PAGE) {
  const editor: WikiEditor = {
    create: vi.fn(async (draft) => ({ ...PAGE, ...draft, updatedAt: 'new' })),
    replaceContent: vi.fn(async (r) => ({
      ...PAGE,
      content: r.content,
      updatedAt: 'new',
    })),
  };
  const wiki: WikiSource = {
    search: async () => [],
    read: async () => current ?? undefined,
  };
  return { deps: { wiki, editor }, editor };
}

describe('assertWritablePath', () => {
  it('階層の path は通し、危ない形は断る', () => {
    expect(() => assertWritablePath('infra/network/known-ips')).not.toThrow();
    expect(() => assertWritablePath('ideta/生駒')).not.toThrow();
    for (const bad of [
      '',
      '/infra',
      'infra/',
      'infra//x',
      '../x',
      'infra/.hidden',
      'a b',
      'a?b',
      'a#b',
      'a%2Fb',
      'a\\b',
      'x'.repeat(201),
    ]) {
      expect(() => assertWritablePath(bad), bad).toThrow(
        /path として使えません/,
      );
    }
  });
});

describe('createWikiPage', () => {
  it('日本語のロケールで作る', async () => {
    const { deps, editor } = setup();

    await createWikiPage(deps, {
      path: 'infra/new',
      title: '新規',
      description: '説明',
      content: '# 新規',
    });

    expect(editor.create).toHaveBeenCalledWith({
      path: 'infra/new',
      locale: 'ja',
      title: '新規',
      description: '説明',
      content: '# 新規',
    });
  });

  it('秘密に見える文字列・空の本文・長すぎる本文・空のタイトルは書かない', async () => {
    const { deps, editor } = setup();
    const base = { path: 'infra/new', title: 't', description: '' };

    await expect(
      createWikiPage(deps, {
        ...base,
        content: 'Authorization: Bearer abcdef0123456789xyz',
      }),
    ).rejects.toThrow(/秘密|トークン/);
    await expect(
      createWikiPage(deps, { ...base, content: '  \n' }),
    ).rejects.toThrow(/空/);
    await expect(
      createWikiPage(deps, {
        ...base,
        content: 'あ'.repeat(MAX_WIKI_WRITE_CHARS + 1),
      }),
    ).rejects.toThrow(/長すぎ/);
    await expect(
      createWikiPage(deps, { ...base, title: ' ', content: 'x' }),
    ).rejects.toThrow(/タイトル/);
    expect(editor.create).not.toHaveBeenCalled();
  });
});

describe('replaceWikiPage', () => {
  it('読んだときの更新日時を添えて置き換える', async () => {
    const { deps, editor } = setup();

    await replaceWikiPage(deps, {
      path: 'infra/memo',
      content: '全部書き直す',
      expectedUpdatedAt: PAGE.updatedAt,
    });

    expect(editor.replaceContent).toHaveBeenCalledWith({
      path: 'infra/memo',
      locale: 'ja',
      content: '全部書き直す',
      expectedUpdatedAt: PAGE.updatedAt,
    });
  });

  it('path が危なければ書き込みの口まで行かない', async () => {
    const { deps, editor } = setup();

    await expect(
      replaceWikiPage(deps, {
        path: '../etc',
        content: 'x',
        expectedUpdatedAt: 't',
      }),
    ).rejects.toThrow();
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });
});

describe('appendToWikiPage', () => {
  it('既存の末尾に足し、読んだ版の更新日時を添える（既存の部分は変えない）', async () => {
    const { deps, editor } = setup();

    await appendToWikiPage(deps, {
      path: 'infra/memo',
      text: '## 追記\n足した',
    });

    expect(editor.replaceContent).toHaveBeenCalledWith({
      path: 'infra/memo',
      locale: 'ja',
      content: '# メモ\n\n既存の本文\n\n## 追記\n足した\n',
      expectedUpdatedAt: PAGE.updatedAt,
    });
  });

  it('ページが無ければ作らずに投げる。足した結果が長すぎても投げる', async () => {
    const missing = setup(null);
    await expect(
      appendToWikiPage(missing.deps, { path: 'infra/none', text: 'x' }),
    ).rejects.toThrow(/ページがありません/);

    const full = setup({
      ...PAGE,
      content: 'あ'.repeat(MAX_WIKI_WRITE_CHARS - 5),
    });
    await expect(
      appendToWikiPage(full.deps, {
        path: 'infra/memo',
        text: 'あ'.repeat(50),
      }),
    ).rejects.toThrow(/長くなりすぎ/);
    expect(full.editor.replaceContent).not.toHaveBeenCalled();
  });

  it('足す文章に秘密に見える文字列があれば書かない', async () => {
    const { deps, editor } = setup();

    await expect(
      appendToWikiPage(deps, {
        path: 'infra/memo',
        text: 'token: Bearer abcdef0123456789xyz',
      }),
    ).rejects.toThrow(/トークン/);
    expect(editor.replaceContent).not.toHaveBeenCalled();
  });
});
