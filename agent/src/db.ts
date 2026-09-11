import { sqlite } from '@flue/runtime/node';
import { env } from './config/env.ts';

/**
 * 会話履歴の永続化と自動圧縮は Flue に委ねる（F-02）。独自の履歴管理は作らない。
 * k8s では PVC 上のパスを FLUE_DB_PATH で渡す。
 */
export default sqlite(env.FLUE_DB_PATH);
