import { composePersonaPrompt } from '../domain/persona.ts';
import type { PersonaDiffStore } from '../domain/ports/persona-diff-store.ts';
import type { SettingsProvider } from '../domain/ports/settings-provider.ts';
import { personaProfileOf } from '../domain/settings.ts';
import type { TenantId } from '../domain/tenant.ts';

export interface PersonaDependencies {
  settings: SettingsProvider;
  diffs: PersonaDiffStore;
}

/**
 * 応答に使う人格を組み立てる（F-32）。
 *
 * 固定モード（F-34）では差分ストアを**呼ばない**。読んでから捨てるのでは
 * なく読まないことが、D-13 でいう決定的な防御そのもの。
 */
export function buildPersonaPrompt(
  deps: PersonaDependencies,
  tenantId: TenantId,
): string {
  const settings = deps.settings.get();
  const locked = settings.behavior.personaLock;
  const diffs = locked ? [] : deps.diffs.list(tenantId);
  return composePersonaPrompt({
    profile: personaProfileOf(settings),
    diffs,
    locked,
  });
}
