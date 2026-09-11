#!/usr/bin/env node
/**
 * 依存方向を機械的に検査する。
 *
 * 明文化された不変条件は目視レビューでは守られない。CI で落とすものだけが残る。
 *
 * - domain は他のどの層にも依存しない（port の定義だけを持つ）
 * - application は domain だけに依存する（infrastructure へは port 越し）
 * - interfaces は infrastructure の実装を直接掴まない（合成ルート経由で受け取る）
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** 層ごとに「import してはいけない層」。 */
const FORBIDDEN = {
  domain: ['application', 'infrastructure', 'interfaces', 'agents', 'tools'],
  application: ['infrastructure', 'interfaces', 'agents', 'tools'],
  interfaces: ['infrastructure'],
};

const IMPORT = /^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

const violations = [];

for await (const file of walk(SRC)) {
  const relativePath = relative(SRC, file);
  const layer = relativePath.split('/')[0];
  const forbidden = FORBIDDEN[layer];
  if (!forbidden) continue;

  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(IMPORT)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    // 合成ルート（src 直下）は層ではなく、どこからでも参照される側なので除外する。
    const segments = specifier.split('/');
    const target = segments.find((segment) => forbidden.includes(segment));
    if (target) {
      violations.push(
        `${relativePath}: ${layer} が ${target} を import しています (${specifier})`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error('依存方向の違反:');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('依存方向 OK');
