import { createHash, timingSafeEqual } from 'node:crypto';

export interface NotifyToken {
  readonly source: string;
  readonly token: string;
}

/**
 * 通知 API の認証（F-18）。
 *
 * **到達性を認証の代わりにしない**（INV-6）。既存 discord-vc は 127.0.0.1
 * バインドで守っていたが、k8s では成立しない。
 *
 * 送信元はトークンから決まる。長さの違いが timingSafeEqual を壊さないよう、
 * 比較は SHA-256 のダイジェスト同士で行う。
 */
export function createNotifyAuthenticator(tokens: readonly NotifyToken[]) {
  const digests = tokens.map((entry) => ({
    source: entry.source,
    digest: createHash('sha256').update(entry.token).digest(),
  }));

  return function authenticate(
    authorization: string | undefined,
  ): string | undefined {
    const presented = authorization?.match(/^Bearer\s+(.+)$/)?.[1];
    if (!presented) return undefined;

    const digest = createHash('sha256').update(presented).digest();
    let matched: string | undefined;
    // 一致しても打ち切らない。打ち切ると応答時間から送信元の並び順が漏れる。
    for (const entry of digests) {
      if (timingSafeEqual(entry.digest, digest)) matched = entry.source;
    }
    return matched;
  };
}
