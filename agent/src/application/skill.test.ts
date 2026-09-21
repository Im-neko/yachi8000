import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ProposeSkillInput,
  SkillStore,
} from '../domain/ports/skill-store.ts';
import type { Settings } from '../domain/settings.ts';
import type { SkillCandidate, SkillStatus } from '../domain/skill.ts';
import {
  approveSkill,
  askForSkillApproval,
  decideSkillByReaction,
  disableSkill,
  mountableSkills,
  proposeSkill,
  rejectAllPendingSkills,
  rejectSkill,
  type SkillDependencies,
} from './skill.ts';

/**
 * SkillStore の代役。
 *
 * **SQL 側の契約（同名の拒否・テナント分離・状態を条件にした遷移）は
 * `infrastructure/skill/sqlite-skill-store.test.ts` が受け持つ。** ここで
 * 確かめるのは、承認フローと固定モードの絞り込みというユースケースの判断。
 */
function createFakeSkillStore(): SkillStore {
  const rows: SkillCandidate[] = [];
  let nextId = 0;

  function get(id: string): SkillCandidate | undefined {
    return rows.find((row) => row.id === id);
  }

  return {
    propose(input: ProposeSkillInput): SkillCandidate {
      if (rows.some((row) => row.name === input.name)) {
        throw new Error(`スキル名 "${input.name}" は既に使われています。`);
      }
      const candidate: SkillCandidate = {
        id: `s${++nextId}`,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        kind: input.kind,
        status: 'pending',
        proposedAt: new Date(1_800_000_000_000 + nextId).toISOString(),
        decidedAt: undefined,
        ask: undefined,
      };
      rows.push(candidate);
      return candidate;
    },

    list(statuses) {
      return rows.filter((row) => statuses.includes(row.status));
    },

    get,

    recordAsk(id, channelId, messageId) {
      const row = get(id);
      if (row) row.ask = { channelId, messageId };
    },

    findByAsk(channelId, messageId) {
      return rows.find(
        (row) =>
          row.ask?.channelId === channelId && row.ask?.messageId === messageId,
      );
    },

    transition(id, from, to) {
      const index = rows.findIndex(
        (row) => row.id === id && from.includes(row.status),
      );
      if (index < 0) return undefined;
      const current = rows[index];
      if (!current) return undefined;
      const moved: SkillCandidate = {
        ...current,
        status: to,
        decidedAt: new Date().toISOString(),
      };
      rows[index] = moved;
      return moved;
    },

    rejectAllPending() {
      let rejected = 0;
      for (const [index, row] of rows.entries()) {
        if (row.status !== 'pending') continue;
        rows[index] = {
          ...row,
          status: 'rejected' satisfies SkillStatus,
          decidedAt: new Date().toISOString(),
        };
        rejected += 1;
      }
      return rejected;
    },

    mountable(kinds) {
      return rows.filter(
        (row) => row.status === 'approved' && kinds.includes(row.kind),
      );
    },
  };
}

function createDeps(personaLock: boolean): SkillDependencies {
  return {
    store: createFakeSkillStore(),
    settings: {
      get: () => ({ behavior: { personaLock } }) as Settings,
    },
    log: {
      info: () => undefined,
      debug: () => undefined,
      warn: () => undefined,
    },
  };
}

function propose(
  deps: SkillDependencies,
  name: string,
  kind: 'knowledge' | 'persona' = 'knowledge',
) {
  return proposeSkill(deps, {
    name,
    description: `${name} を使う場面`,
    instructions: `${name} の中身`,
    kind,
  });
}

describe('proposeSkill', () => {
  let deps: SkillDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('pending として記録する（承認まで応答に出ない）', () => {
    expect(propose(deps, 'ok-skill').status).toBe('pending');
    expect(mountableSkills(deps)).toHaveLength(0);
  });

  // 承認まで通してから defineSkill に蹴られると、承認操作か毎ターンの
  // render が壊れる。入口で落とす。
  it('Flue のスキルとして成立しない候補は保存しない', () => {
    expect(() => propose(deps, 'Bad_Name')).toThrow();
    expect(mountableSkills(deps)).toHaveLength(0);
  });
});

describe('承認フロー（F-41, F-43）', () => {
  let deps: SkillDependencies;

  beforeEach(() => {
    deps = createDeps(false);
  });

  it('承認するとマウント対象になる', () => {
    const candidate = propose(deps, 'to-approve');
    expect(approveSkill(deps, candidate.id)?.status).toBe('approved');
    expect(mountableSkills(deps).map((s) => s.name)).toEqual(['to-approve']);
  });

  it('却下したものは承認できない', () => {
    const candidate = propose(deps, 'to-reject');
    rejectSkill(deps, candidate.id);
    expect(approveSkill(deps, candidate.id)).toBeUndefined();
  });

  it('承認済みを却下しようとしても動かない', () => {
    const candidate = propose(deps, 'already-approved');
    approveSkill(deps, candidate.id);
    expect(rejectSkill(deps, candidate.id)).toBeUndefined();
  });

  it('無効化するとマウント対象から外れ、承認し直せる', () => {
    const candidate = propose(deps, 'toggled');
    approveSkill(deps, candidate.id);
    expect(disableSkill(deps, candidate.id)?.status).toBe('disabled');
    expect(mountableSkills(deps)).toHaveLength(0);
    approveSkill(deps, candidate.id);
    expect(mountableSkills(deps)).toHaveLength(1);
  });

  it('一括却下は pending だけを動かす', () => {
    const pending = propose(deps, 'pending-one');
    const approved = propose(deps, 'approved-one');
    approveSkill(deps, approved.id);

    expect(rejectAllPendingSkills(deps)).toBe(1);
    expect(mountableSkills(deps).map((s) => s.name)).toEqual(['approved-one']);
    expect(approveSkill(deps, pending.id)).toBeUndefined();
  });
});

describe('mountableSkills と固定モード（F-34, Q-16）', () => {
  it('固定モードでは人格に関わるスキルをマウントしない', () => {
    const deps = createDeps(true);
    const knowledge = propose(deps, 'a-knowledge', 'knowledge');
    const persona = propose(deps, 'a-persona', 'persona');
    approveSkill(deps, knowledge.id);
    approveSkill(deps, persona.id);

    expect(mountableSkills(deps).map((s) => s.name)).toEqual(['a-knowledge']);
  });

  // 固定モードは「読まない」だけ。承認そのものは止めないので、OFF に
  // 戻せば効きはじめる（D-13 と同じ形）。
  it('固定モード中も人格スキルの承認は通る', () => {
    const deps = createDeps(true);
    const persona = propose(deps, 'a-persona', 'persona');
    expect(approveSkill(deps, persona.id)?.status).toBe('approved');
  });
});

describe('リアクションでの承認（F-44）', () => {
  function createPromptHarness() {
    const asked: { channelId: string; text: string }[] = [];
    const settled: { messageId: string; text: string }[] = [];
    let nextMessageId = 0;
    const deps = createDeps(false);
    deps.prompt = {
      ask: async (channelId, text) => {
        asked.push({ channelId, text });
        return `m${++nextMessageId}`;
      },
      settle: async (_channelId, messageId, text) => {
        settled.push({ messageId, text });
      },
    };
    return { deps, asked, settled };
  }

  /** 問いかけは fire-and-forget なので、記録が済むまで流す。 */
  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('提案したら、その場で中身を見せて聞く', async () => {
    const h = createPromptHarness();
    const candidate = propose(h.deps, 'keep-it-short');
    askForSkillApproval(h.deps, candidate, 'c1');
    await settle();

    expect(h.asked).toHaveLength(1);
    // **中身を見せる。** 名前だけでは判断できない。
    expect(h.asked[0]?.text).toContain('keep-it-short の中身');
    expect(h.deps.store.get(candidate.id)?.ask).toEqual({
      channelId: 'c1',
      messageId: 'm1',
    });
  });

  it('✅ で承認し、問いかけを結果へ書き換える', async () => {
    const h = createPromptHarness();
    const candidate = propose(h.deps, 'keep-it-short');
    askForSkillApproval(h.deps, candidate, 'c1');
    await settle();

    const outcome = await decideSkillByReaction(h.deps, {
      channelId: 'c1',
      messageId: 'm1',
      emoji: '✅',
      userId: 'u1',
      userName: 'neko',
    });

    expect(outcome).toEqual({
      kind: 'decided',
      candidate: expect.objectContaining({ status: 'approved' }),
    });
    // **問いかけのまま残さない**（過去ログから二度押しされる）。
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]?.text).toContain('neko');
  });

  it('❌ で却下する', async () => {
    const h = createPromptHarness();
    const candidate = propose(h.deps, 'keep-it-short');
    askForSkillApproval(h.deps, candidate, 'c1');
    await settle();

    await decideSkillByReaction(h.deps, {
      channelId: 'c1',
      messageId: 'm1',
      emoji: '❌',
      userId: 'u1',
      userName: 'neko',
    });

    expect(h.deps.store.get(candidate.id)?.status).toBe('rejected');
  });

  // ただの雑談に付いた絵文字が毎回ここへ来る。
  it('関係のない投稿への絵文字は素通しする', async () => {
    const h = createPromptHarness();

    expect(
      await decideSkillByReaction(h.deps, {
        channelId: 'c1',
        messageId: 'other',
        emoji: '✅',
        userId: 'u1',
        userName: 'neko',
      }),
    ).toEqual({ kind: 'unrelated' });
  });

  it('決まったあとに押されても、結果は変わらない', async () => {
    const h = createPromptHarness();
    const candidate = propose(h.deps, 'keep-it-short');
    askForSkillApproval(h.deps, candidate, 'c1');
    await settle();

    const decide = (emoji: string) =>
      decideSkillByReaction(h.deps, {
        channelId: 'c1',
        messageId: 'm1',
        emoji,
        userId: 'u1',
        userName: 'neko',
      });
    await decide('✅');
    const second = await decide('❌');

    expect(second.kind).toBe('already-decided');
    expect(h.deps.store.get(candidate.id)?.status).toBe('approved');
  });

  it('聞けなくても候補は残る（/skill から承認できる）', async () => {
    const h = createPromptHarness();
    h.deps.prompt = {
      ask: async () => {
        throw new Error('Discord が落ちている');
      },
      settle: async () => undefined,
    };
    const candidate = propose(h.deps, 'keep-it-short');
    askForSkillApproval(h.deps, candidate, 'c1');
    await settle();

    expect(h.deps.store.get(candidate.id)?.status).toBe('pending');
  });
});
