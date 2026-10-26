import './isolated-guard.ts';
/**
 * 端到端自检：造模板 → 上传 → 扫描变量 → 填充 → 保存 → 检索 → 建工作台 → 勾清单
 *   node packages/server/test/e2e.ts
 * 需要服务已启动。
 */
import PizZip from 'pizzip';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE!;
const TMP = join(process.env.WORKBENCH_ISOLATION_ROOT!, 'fixtures');
mkdirSync(TMP, { recursive: true });

let pass = 0;
let failCount = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // 没有 body 的请求（如 DELETE）不能带 Content-Type，否则服务端会拒收空 body
    headers:
      init?.body instanceof FormData || init?.body === undefined
        ? init?.headers
        : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

/* ---------- 1. 生成一个真实的 docx 模板 ---------- */

function makeDocxTemplate(path: string): void {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder('_rels')!.file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>月度安全检查记录表</w:t></w:r></w:p>
<w:p><w:r><w:t>检查月份：</w:t></w:r><w:r><w:t>{检查月份}</w:t></w:r></w:p>
<w:p><w:r><w:t>检查区域：</w:t></w:r><w:r><w:t>{检查区域}</w:t></w:r></w:p>
<w:p><w:r><w:t>检查人：</w:t></w:r><w:r><w:t>{检查人}</w:t></w:r></w:p>
<w:p><w:r><w:t>检查日期：</w:t></w:r><w:r><w:t>{检查日期}</w:t></w:r></w:p>
<w:p><w:r><w:t>检查情况：</w:t></w:r></w:p>
<w:p><w:r><w:t>{检查情况}</w:t></w:r></w:p>
<w:p><w:r><w:t>结论：{结论}</w:t></w:r></w:p>
<w:p><w:r><w:t>单位：{单位名称}</w:t></w:r></w:p>
</w:body>
</w:document>`;
  zip.folder('word')!.file('document.xml', doc);
  writeFileSync(path, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

/* ---------- 主流程 ---------- */

/**
 * 自检会在真实库里建工作台和模板，所以命名一律带【自检】前缀：
 * 一是跑之前能按这个名字把上次残留清掉（中途失败也不会越积越多），
 * 二是万一忘了清，你在界面上也一眼认得出哪些不是自己的东西。
 */
const MARK = '【自检】';
const TEST_WB_NAMES = [`${MARK}项目式安全工作`, `${MARK}行政管理工作`];
const TPL_FILE = `${MARK}月度安全检查记录表`;

console.log('\n[1] 服务连通性');
const health = await api('/api/health');
check('GET /api/health 返回 ok', health.json?.ok === true, health.json);

console.log('\n[2] 准备模板文件');
const tplPath = join(TMP, `${TPL_FILE}.docx`);
makeDocxTemplate(tplPath);
check('生成 docx 模板文件', existsSync(tplPath));

console.log('\n[2b] 清理上次自检残留');
const staleWb = await api('/api/workbenches');
for (const w of staleWb.json?.data?.items ?? []) {
  if (!String(w.name).startsWith(MARK)) continue;
  const r = await api(`/api/workbenches/${w.id}`, { method: 'DELETE' });
  check(`清掉上次留下的工作台「${w.name}」`, r.json?.ok === true, r.json);
}
const staleTpl = await api('/api/templates?limit=300');
for (const t of staleTpl.json?.data?.items ?? []) {
  if (!String(t.name).startsWith(MARK)) continue;
  const r = await api(`/api/templates/${t.id}/permanent`, { method: 'DELETE' });
  check(`清掉上次留下的模板「${t.name}」`, r.json?.ok === true, r.json);
}

console.log('\n[3] 上传模板并自动扫描变量');
/**
 * 工作类型有两种模式，测试要各走一遍：
 *   process  项目类：建台时按阶段实例化，带材料清单
 *   document 行政管理：没有阶段，按频率反复做
 * 所以这里先查出实际存在的工作类型，而不是写死 id —— 用户删改过类型后测试仍然成立。
 */
const typesRes = await api('/api/work-types');
const allTypes: any[] = typesRes.json?.data?.items ?? [];
const projType = allTypes.find((t) => t.code==='project' && t.mode === 'process' && (t.position_count ?? 0) > 0);
const adminType = allTypes.find((t) => t.mode === 'document' && !t.period_defaults);
check('存在流程型工作类型（项目类）', Boolean(projType), allTypes.map((t) => `${t.id}:${t.name}:${t.mode}`));
check('存在文书型工作类型（行政管理）', Boolean(adminType), allTypes.map((t) => `${t.id}:${t.name}:${t.mode}`));

const fd = new FormData();
fd.append('file', new Blob([await (await import('node:fs')).promises.readFile(tplPath)]), `${TPL_FILE}.docx`);
fd.append('category', 'project');
fd.append('workTypeId', String(projType.id));
const up = await api('/api/templates/upload', { method: 'POST', body: fd });
check('上传成功', up.status === 201 && up.json?.ok === true, up.json);
const tplId = up.json?.data?.items?.[0]?.template?.id as number;
check('拿到模板 id', Number.isFinite(tplId), up.json?.data);
check('模板名保留原始文件名', up.json?.data?.items?.[0]?.template?.name === TPL_FILE, up.json?.data?.items?.[0]?.template?.name);
check('自动扫描到变量', (up.json?.data?.items?.[0]?.template?.variable_count ?? 0) >= 5, up.json?.data?.items?.[0]?.template);

console.log('\n[4] 读取变量清单并补充中文标签');
const detail = await api(`/api/templates/${tplId}`);
const vars = detail.json?.data?.vars?.variables ?? [];
check('变量清单取自模板', vars.length >= 5, vars.map((v: any) => v.name));
const wantVars = ['检查月份', '检查区域', '检查人', '检查日期', '检查情况', '结论', '单位名称'];
check('变量名与模板一致', wantVars.every((n) => vars.some((v: any) => v.name === n)), vars.map((v: any) => v.name));
const put = await api(`/api/templates/${tplId}/vars`, {
  method: 'PUT',
  body: JSON.stringify({
    variables: vars.map((v: any) => ({ ...v, label: v.name, type: v.name === '检查情况' ? 'longtext' : 'text', required: v.name !== '结论' })),
  }),
});
check('保存变量说明', put.json?.ok === true, put.json);

console.log('\n[5] 新建工作台（项目类，走流程）');
const mk = await api('/api/workbenches', {
  method: 'POST',
  body: JSON.stringify({ name: TEST_WB_NAMES[0], workTypeId: projType.id, owner: '张工', summary: '一季度例行检查' }),
});
check('创建工作台', mk.status === 201 && mk.json?.ok === true, mk.json);
const wbId = mk.json?.data?.id as number;
check('自动生成编号', Boolean(mk.json?.data?.code), mk.json?.data?.code);
check('项目编号用 P 前缀', /-P-\d+$/.test(mk.json?.data?.code ?? ''), mk.json?.data?.code);
check('自动建目录', Boolean(mk.json?.data?.folder_path), mk.json?.data?.folder_path);

const wbDetail = await api(`/api/workbenches/${wbId}`);
check('工作台按模板生成了阶段', (wbDetail.json?.data?.positions?.length ?? 0) === projType.position_count, {
  got: wbDetail.json?.data?.positions?.length,
  want: projType.position_count,
});
check('阶段里带出了材料清单', (wbDetail.json?.data?.positions?.[0]?.checklist?.length ?? 0) > 0, wbDetail.json?.data?.positions?.[0]?.checklist);

console.log('\n[6] 不调模型，先渲染一份（手工填写路径）');
const fields = await api(`/api/generate/fields/${tplId}?workbenchId=${wbId}`);
check('取到填写字段和上下文预填', fields.json?.ok === true && (fields.json?.data?.variables?.length ?? 0) >= 5, fields.json?.data?.variables?.length);
const contextPreset = fields.json?.data?.variables?.find((v: any) => v.name === '检查人')?.preset;
check('从工作台带出负责人预填', contextPreset === '张工', contextPreset);

const manualValues: Record<string, string> = {
  检查月份: '2026年3月',
  检查区域: '办公楼一至三层',
  检查人: '张工',
  检查日期: '2026年3月15日',
  检查情况: '消火栓压力正常，应急照明抽查 6 处均可用；三层配电箱前有杂物堆放，已现场整改。',
  结论: '本次检查未发现重大隐患。',
  单位名称: '某某单位',
};
const preview = await fetch(`${BASE}/api/generate/preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ templateId: tplId, values: manualValues }),
});
const previewBuf = Buffer.from(await preview.arrayBuffer());
check('预览返回文件流', preview.status === 200 && previewBuf.length > 1000, { status: preview.status, size: previewBuf.length });
const previewZip = new PizZip(previewBuf);
const previewXml = previewZip.file('word/document.xml')?.asText() ?? '';
check('渲染后变量已被替换', previewXml.includes('2026年3月') && previewXml.includes('张工'), previewXml.slice(0, 200));
check('渲染后没有残留占位符', !previewXml.includes('{检查月份}') && !previewXml.includes('{检查情况}'), previewXml.match(/\{[^}]+\}/g));

// 故意漏填一项：没给值的变量要原样保留占位符，方便打开 Word 时一眼看到漏在哪
const { 结论: _omit, ...partialValues } = manualValues;
const partial = await fetch(`${BASE}/api/generate/preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ templateId: tplId, values: partialValues }),
});
const partialXml = new PizZip(Buffer.from(await partial.arrayBuffer())).file('word/document.xml')?.asText() ?? '';
check('没填的变量保留为占位符便于发现遗漏', partialXml.includes('{结论}'), partialXml.match(/\{[^}]+\}/g));

console.log('\n[7] 保存成文件（落到工作台 _生成文书）');
const save = await api('/api/generate/save', {
  method: 'POST',
  body: JSON.stringify({ templateId: tplId, workbenchId: wbId, values: manualValues, mode: 'manual' }),
});
check('保存成功', save.status === 201 && save.json?.ok === true, save.json);
const artifactId = save.json?.data?.artifact?.id as number;
const artifactRel = save.json?.data?.artifact?.file_rel as string;
check('文件名符合命名规范（日期_模板名_版本）', typeof artifactRel === 'string' && /\/\d{14}_.+_v\d+\.docx$/.test(artifactRel), artifactRel);
check('落在 _生成文书 目录', typeof artifactRel === 'string' && artifactRel.includes('_生成文书'), artifactRel);

const saveNamed = await api('/api/generate/save', {
  method: 'POST',
  body: JSON.stringify({ templateId: tplId, workbenchId: wbId, values: manualValues, mode: 'manual', fileName: '自定义名称' }),
});
check('自定义文件名可用', /自定义名称\.docx$/.test(saveNamed.json?.data?.artifact?.file_rel ?? ''), saveNamed.json?.data?.artifact?.file_rel);
const saveAgain = await api('/api/generate/save', {
  method: 'POST',
  body: JSON.stringify({ templateId: tplId, workbenchId: wbId, values: manualValues, mode: 'manual', fileName: '自定义名称' }),
});
check('重名自动加版本号不覆盖', /自定义名称_v2\.docx$/.test(saveAgain.json?.data?.artifact?.file_rel ?? ''), saveAgain.json?.data?.artifact?.file_rel);

console.log('\n[8] 文件下载与全文检索');
const dl = await fetch(`${BASE}/api/artifacts/${artifactId}/file`);
const dlBuf = Buffer.from(await dl.arrayBuffer());
check('下载生成的文件', dl.status === 200 && dlBuf.length === previewBuf.length, { status: dl.status, size: dlBuf.length });

const search1 = await api('/api/search?q=' + encodeURIComponent('应急照明'));
check('按文件正文内容检索命中', (search1.json?.data?.total ?? 0) >= 1, search1.json?.data);
const search2 = await api('/api/search?q=' + encodeURIComponent('安全检查'));
check('按标题检索命中', (search2.json?.data?.total ?? 0) >= 1, search2.json?.data);
const search3 = await api('/api/search?q=' + encodeURIComponent('不存在的词xyz'));
check('无关键词返回空', (search3.json?.data?.total ?? 0) === 0, search3.json?.data);

console.log('\n[9] 清单勾选与进度');
const firstPos = wbDetail.json?.data?.positions?.[0];
const firstItem = firstPos?.checklist?.[0];
const chk = await api(`/api/checklist/${firstItem.id}`, { method: 'PUT', body: JSON.stringify({ status: 'done', doneBy: '张工' }) });
check('勾选清单项', chk.json?.ok === true, chk.json);
const after = await api(`/api/workbenches/${wbId}`);
check('提供标记不能替代材料核对', (after.json?.data?.stats?.materialDone ?? 0) === 0, after.json?.data?.stats);

console.log('\n[10] 影像证据上传');
const jpg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const evFd = new FormData();
evFd.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'kaimi.jpg');
evFd.append('workbenchId', String(wbId));
evFd.append('positionCode', 'A01');
evFd.append('phase', '接收与登记');
evFd.append('note', '开箱外包装');
const ev = await api('/api/artifacts/evidence', { method: 'POST', body: evFd });
check('上传影像证据', ev.status === 201 && ev.json?.ok === true, ev.json);
check('影像按规范命名', typeof ev.json?.data?.items?.[0]?.file_rel === 'string' && /_\d{3}_/.test(ev.json.data.items[0].file_rel), ev.json?.data?.items?.[0]?.file_rel);

console.log('\n[11] 统计与目录');
const stats = await api('/api/files/stats');
check('文件统计有数据', (stats.json?.data?.total ?? 0) >= 2, stats.json?.data);
const folder = await api(`/api/workbenches/${wbId}/folder`);
check('工作台目录结构已生成', (folder.json?.data?.items?.length ?? 0) > 3, folder.json?.data?.items?.map((i: any) => i.path));

console.log('\n[12] 行政管理走文书模式（不建阶段、按频率重复）');
const mkA = await api('/api/workbenches', {
  method: 'POST',
  body: JSON.stringify({
    name: TEST_WB_NAMES[1],
    workTypeId: adminType.id,
    recurrence: 'monthly',
    recurDay: 20,
    remindDays: 2,
  }),
});
check('创建行政管理工作', mkA.status === 201 && mkA.json?.ok === true, mkA.json);
const wbAId = mkA.json?.data?.id as number;
check('行政管理编号用 A 前缀', /-A-\d+$/.test(mkA.json?.data?.code ?? ''), mkA.json?.data?.code);
const detailA = await api(`/api/workbenches/${wbAId}`);
const wbA = detailA.json?.data?.workbench;
check('行政管理工作不建阶段', (detailA.json?.data?.positions?.length ?? -1) === 0, detailA.json?.data?.positions?.length);
check('按频率排期已算好', wbA?.schedule?.recurring === true && Boolean(wbA?.schedule?.nextDue), wbA?.schedule);
const doneA = await api(`/api/workbenches/${wbAId}/complete`, { method: 'POST' });
check(
  '完成本期后回到进行中并给出下期日期',
  doneA.json?.data?.status === 'active' && Boolean(doneA.json?.data?.nextDue),
  doneA.json?.data,
);

console.log('\n[13] 清理自检产生的数据');
const delA = await api(`/api/workbenches/${wbAId}`, { method: 'DELETE' });
check('删除自检工作台', delA.json?.ok === true, delA.json);
const delWb = await api(`/api/workbenches/${wbId}`, { method: 'DELETE' });
check('删除流程自检工作台（含生成的文书）', delWb.json?.ok === true && (delWb.json?.data?.deleted?.artifacts ?? 0) >= 3, delWb.json);
const delTpl = await api(`/api/templates/${tplId}`, { method: 'DELETE' });
check('删除自检模板', delTpl.json?.ok === true, delTpl.json);
const leftWb = await api('/api/workbenches');
check(
  '自检没有在工作台里留下垃圾数据',
  !(leftWb.json?.data?.items ?? []).some((w: any) => w.id === wbId || w.id === wbAId),
  (leftWb.json?.data?.items ?? []).map((w: any) => `${w.id}:${w.name}`),
);

console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项\n`);
if (failCount > 0) process.exitCode = 1;
