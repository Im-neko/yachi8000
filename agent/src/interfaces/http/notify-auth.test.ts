import { describe, expect, it } from 'vitest';
import { createNotifyAuthenticator } from './notify-auth.ts';

const TOKENS = [
  { source: 'claude-code', token: 'aaaa' },
  { source: 'ci', token: 'bbbb' },
];

describe('createNotifyAuthenticator', () => {
  const authenticate = createNotifyAuthenticator(TOKENS);

  it('トークンから送信元を決める', () => {
    expect(authenticate('Bearer aaaa')).toBe('claude-code');
    expect(authenticate('Bearer bbbb')).toBe('ci');
  });

  it('未知のトークンは拒否する', () => {
    expect(authenticate('Bearer cccc')).toBeUndefined();
  });

  it('長さの違うトークンでも落ちずに拒否する', () => {
    expect(authenticate('Bearer a')).toBeUndefined();
    expect(authenticate(`Bearer ${'a'.repeat(500)}`)).toBeUndefined();
  });

  it('Bearer 以外・未指定は拒否する', () => {
    expect(authenticate(undefined)).toBeUndefined();
    expect(authenticate('aaaa')).toBeUndefined();
    expect(authenticate('Basic aaaa')).toBeUndefined();
  });
});
