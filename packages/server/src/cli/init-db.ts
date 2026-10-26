/**
 * 数据库初始化 / 自检 CLI
 *   npm run db:init
 */
import { bootstrap } from '../core/bootstrap.ts';
import { getDbPath, all } from '../db/index.ts';
import { DATA_ROOT } from '../core/config.ts';
import { listTemplates, listWorkTypes, listPositions } from '../domain/service.ts';
import { searchArtifacts } from '../core/search.ts';

const r = bootstrap();
console.log('数据库：', getDbPath());
console.log('数据目录：', DATA_ROOT);
void r;

const types = listWorkTypes();
console.log(`\n工作类型 ${types.length} 个：`);
for (const t of types) {
  console.log(`  - ${t.code} ${t.name}（${t.category}）阶段 ${t.position_count} / 模板 ${t.template_count} / 工作台 ${t.workbench_count}`);
  for (const p of listPositions(t.id)) {
    console.log(`      ${String(p.seq).padStart(2, '0')} ${p.name}  材料 ${p.materials.length} 项 / 影像 ${p.evidences.length} 项`);
  }
}

const tpl = listTemplates();
console.log(`\n模板 ${tpl.length} 个`);

const providers = all<{ code: string; name: string; enabled: number; has_key: number }>(
  "SELECT code, name, enabled, CASE WHEN api_key IS NULL OR api_key = '' THEN 0 ELSE 1 END AS has_key FROM ai_provider ORDER BY sort_order",
);
console.log(`\n模型服务商 ${providers.length} 个：`);
for (const p of providers) console.log(`  - ${p.code.padEnd(20)} ${p.name}  启用=${p.enabled} 已配Key=${p.has_key}`);

const profiles = all<{ purpose: string; name: string; model: string | null }>('SELECT purpose, name, model FROM ai_profile ORDER BY purpose');
console.log(`\n模型档案 ${profiles.length} 个：`);
for (const p of profiles) console.log(`  - ${p.purpose.padEnd(10)} ${p.name}  模型=${p.model ?? '(未设)'}`);

// FTS 自检
const s = searchArtifacts('验收');
console.log(`\n全文检索自检：检索"验收" 命中 ${s.total} 条`);

const settings = all<{ key: string }>('SELECT key FROM app_setting ORDER BY key');
console.log(`\n配置项 ${settings.length} 个`);
console.log('\n自检完成。');
