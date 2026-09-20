import { readFile } from 'node:fs/promises';
import type { ModelFileReader } from '../../domain/ports/model-file-reader.ts';

/** ファイルが無いときの errno。置き忘れと本当の失敗を分けるために見る。 */
const NOT_FOUND = 'ENOENT';

/**
 * VRM を PVC 上のファイルから読む（→ D-36 の 2）。
 *
 * 毎回読み直す。**キャッシュは持たない** —— 基準機で 10.7 MB、差し替えは
 * 人が手で行う頻度なので、メモリに抱えて古いものを返し続けるほうが困る。
 * ブラウザ側のキャッシュは HTTP のヘッダで効かせる。
 */
export function createFileModelReader(): ModelFileReader {
  return {
    async read(path: string): Promise<Uint8Array | undefined> {
      try {
        return await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === NOT_FOUND) {
          return undefined;
        }
        throw error;
      }
    },
  };
}
