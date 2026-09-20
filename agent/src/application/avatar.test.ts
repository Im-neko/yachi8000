import { describe, expect, it } from 'vitest';
import type { ModelFileReader } from '../domain/ports/model-file-reader.ts';
import type { Settings } from '../domain/settings.ts';
import { type AvatarDependencies, avatarModel, avatarView } from './avatar.ts';

const CONFIGURED = {
  avatar: {
    vrmPath: '/data/avatar.vrm',
    idleExpression: 'happy',
    camera: { targetHeight: 1.3, distance: 1.5 },
  },
} as unknown as Settings;

const UNCONFIGURED = {} as unknown as Settings;

function createDeps(
  settings: Settings,
  read: ModelFileReader['read'],
): AvatarDependencies & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    settings: { get: () => settings },
    models: { read },
    events: { subscribe: () => () => undefined },
    log: {
      warn: (_context, message) => {
        warnings.push(message);
      },
    },
    warnings,
  };
}

describe('avatarView', () => {
  it('設定が無ければ undefined（会話は止めない）', () => {
    expect(avatarView(createDeps(UNCONFIGURED, async () => undefined))).toBe(
      undefined,
    );
  });

  it('設定をそのまま返す', () => {
    const view = avatarView(createDeps(CONFIGURED, async () => undefined));
    expect(view?.idleExpression).toBe('happy');
    expect(view?.camera).toEqual({ targetHeight: 1.3, distance: 1.5 });
  });
});

describe('avatarModel', () => {
  it('読めたら返す', async () => {
    const deps = createDeps(CONFIGURED, async () => new Uint8Array([1, 2]));
    await expect(avatarModel(deps)).resolves.toEqual({
      kind: 'ok',
      bytes: new Uint8Array([1, 2]),
    });
  });

  // 「設定が無い」と「置かれていない」は直し方が違う（前者は設定を書く、
  // 後者はファイルを置く）。ひとまとめにすると利用者がどちらか分からない。
  it('設定が無いことと、置かれていないことを分ける', async () => {
    await expect(
      avatarModel(createDeps(UNCONFIGURED, async () => undefined)),
    ).resolves.toEqual({ kind: 'not-configured' });

    await expect(
      avatarModel(createDeps(CONFIGURED, async () => undefined)),
    ).resolves.toEqual({ kind: 'missing' });
  });

  it('置かれていないことをログに残す（画面には出さない）', async () => {
    const deps = createDeps(CONFIGURED, async () => undefined);
    await avatarModel(deps);
    expect(deps.warnings).toHaveLength(1);
  });

  // 置き忘れと本当の失敗を同じ扱いにすると、権限の間違いが「置いていない」
  // に化けて延々と直らない。
  it('読めない理由が別ならそのまま投げる', async () => {
    const deps = createDeps(CONFIGURED, async () => {
      throw new Error('EACCES');
    });
    await expect(avatarModel(deps)).rejects.toThrow(/EACCES/);
  });

  // リクエストからパスを受け取らない（→ D-36 の 2）。読むのは設定が
  // 指す 1 ファイルだけ。
  it('読みに行くのは設定が指すパスだけ', async () => {
    const asked: string[] = [];
    const deps = createDeps(CONFIGURED, async (path) => {
      asked.push(path);
      return new Uint8Array();
    });
    await avatarModel(deps);
    expect(asked).toEqual(['/data/avatar.vrm']);
  });
});
