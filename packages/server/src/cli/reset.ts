/**
 * 清空业务数据（保留模板与配置），把系统恢复到"刚装好"的状态。
 *
 *   node packages/server/src/cli/reset.ts            只清业务数据
 *   node packages/server/src/cli/reset.ts --with-files  连数据目录里的文件一起删
 *   node packages/server/src/cli/reset.ts --drop-templates  同时删除模板记录
 *   node packages/server/src/cli/reset.ts --providers   复原模型接入配置
 *                                                      （删掉自建服务商、内置服务商启用状态与模型档案回到默认）
 *
 * 注意：这是不可撤销的操作，执行前会要求确认。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { bootstrap } from '../core/bootstrap.ts';
import { DATA_ROOT, DIRS } from '../core/config.ts';
import { all, run, tx } from '../db/index.ts';
import { BUILTIN_PROVIDERS, seedProviders } from '../ai/providers.ts';


const args = process.argv.slice(2);
const withFiles = args.includes('--with-files');
const keepTemplates = !args.includes('--drop-templates');
if(args.includes('--keep-templates') && args.includes('--drop-templates'))throw new Error('保留和删除模板参数不能同时使用');
const resetProviders = args.includes('--providers');
const yes = args.includes('--yes') || args.includes('-y');

console.log('');
console.log('即将清空：');
console.log('  · 所有工作台、阶段进度、清单勾选记录');
console.log('  · 所有文件记录、生成记录、模型调用日志、知识库内容与向量');
console.log(keepTemplates ? '  · 保留：模板库与系统配置' : '  · 同时删除：模板库');
if (resetProviders) console.log('  · 复原：模型服务商（删除自建、内置回到默认启用状态）与模型档案　⚠ 已填的 API Key 会一并清掉');
console.log(withFiles ? `  · 同时删除磁盘文件：${join(DATA_ROOT, DIRS.workbench)}` : '  · 磁盘上的文件全部保留');
console.log('');

if (!yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('确认执行？输入 yes 继续：');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('已取消，什么都没做。');
    process.exit(0);
  }
}

bootstrap();

tx(() => {
  // Newer business tables reference messages, artifacts and periods without cascades.
  // Clear dependants first so a full reset remains valid with foreign keys enabled.
  for (const table of ['business_ai_run', 'artifact_fact_review', 'period_material',
    'timesheet_run', 'timesheet_source', 'workflow_event', 'quick_todo',
    'doc_kb_link', 'kb_change_impact', 'ai_request', 'app_health_event', 'compliance_exception']) {
    run(`DELETE FROM ${table}`);
  }
  run('DELETE FROM agent_action');run('DELETE FROM agent_message');run('DELETE FROM agent_session');run('DELETE FROM agent_memory');
  run('DELETE FROM archive_proposal');
  // 片段 FTS 内容表先清（019 建的；它带触发器同步 kb_chunk_fts），再清块本体，
  // 否则重置后 kb_chunk_fts 里会留一批指向已删块的幽灵行（搜到点开是空的）
  run('DELETE FROM kb_chunk_search');
  run('DELETE FROM kb_chunk');
  run('DELETE FROM kb_document');
  run('DELETE FROM kb_extract_item');
  run('DELETE FROM kb_extract_job');
  run('DELETE FROM kb_source');
  run('DELETE FROM ocr_item');
  run('DELETE FROM artifact_search');
  run('DELETE FROM ai_call_log');
  run('DELETE FROM generation_log');
  // 整库重置：这里**有意不按** `deleted_at IS NULL` 过滤 —— 重置的语义就是"清掉一切"。
  // 回收站里的行（`deleted_at IS NOT NULL`）必须一起清掉；只清在用的会留下一批永远恢复不了、
  // 也没人看得见的垃圾行（工作台行没了、它的文件记录还在）：这一处**有意不按 `deleted_at IS NULL` 过滤**，不是漏了。
  run('DELETE FROM artifact');
  run('DELETE FROM inspection_record');
  run('DELETE FROM work_period');
  run('DELETE FROM work_period_rule');
  run('DELETE FROM workbench');
  if (!keepTemplates) {
    run('DELETE FROM material_check WHERE template_id IS NOT NULL');
    run("UPDATE template SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    run('DELETE FROM template');
  }
  if (resetProviders) {
    // 自建服务商（多为测试用的）直接删掉；预置的清空 Key 并回到默认启用状态
    run('DELETE FROM ai_provider WHERE is_builtin = 0');
    run('UPDATE ai_provider SET api_key = NULL, enabled = 0');
    run('DELETE FROM ai_profile');
  }
});

if (resetProviders) {
  run("UPDATE ai_provider SET enabled=CASE WHEN code IN ('deepseek','openai-compatible') THEN 1 ELSE 0 END");
  seedProviders();
  const enabled = all<{ code: string; enabled: number }>('SELECT code, enabled FROM ai_provider ORDER BY sort_order');
  console.log('已复原模型接入：');
  for (const p of enabled) {
    const builtin = BUILTIN_PROVIDERS.find((b) => b.code === p.code);
    console.log(`  ${p.code.padEnd(20)} ${p.enabled ? '已启用' : '已停用'}${builtin ? '' : '（非预置）'}`);
  }
  console.log('  提醒：预置服务商的默认状态是「DeepSeek 与 OpenAI 兼容」启用，其余停用；API Key 已清空，需要重新填写。');
}

if (withFiles) {
  for (const dir of [join(DATA_ROOT, DIRS.workbench), join(DATA_ROOT, DIRS.inbox)]) {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        try {
          rmSync(p, { recursive: statSync(p).isDirectory(), force: true });
        } catch (e) {
          console.warn(`删不掉 ${p}：${(e as Error).message}`);
        }
      }
    }
  }
}

console.log('已清空。模板与配置' + (keepTemplates ? '保留' : '已删除') + '，磁盘文件' + (withFiles ? '已删除' : '保留') + '。');
console.log('重启服务后即为初始状态。');
