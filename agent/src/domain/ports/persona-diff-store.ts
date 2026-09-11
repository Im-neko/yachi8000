import type { PersonaDiff } from '../persona.ts';
import type { TenantId } from '../tenant.ts';

/**
 * 人格の変化差分（F-33）の読み出し。
 *
 * エージェントの render はプロンプトを同期で組み立てるので、この port も
 * 同期にする。フェーズ 4 の実装先は SQLite（同期ドライバ）。
 */
export interface PersonaDiffStore {
  list(tenantId: TenantId): readonly PersonaDiff[];
}
