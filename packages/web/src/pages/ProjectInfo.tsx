/**
 * 工作台 · 项目信息
 *
 * 界面上一律叫「项目信息」—— 指这个项目本身的固定信息
 * （项目名称、合同编号、甲乙方、金额、日期、人员…）。
 *
 * 它和另外两个概念不是一回事：
 *   · 文件库/归档      项目产出的文件（生成的文书、照片、扫描件）
 *   · 档案目录（卷内目录）  项目结束时移交用的资料清单
 *   · 项目信息         这里 —— 项目本身的属性数据，填一次、所有文书自动带出
 *
 * 之所以做成独立一页：实测 48 份模板里，113 个变量名（占 18%）承担了 45% 的引用，
 * 这些反复出现的项目信息不该在每份文书里重打一遍。
 */
import { useEffect,useMemo, useRef, useState } from 'react';
import {useEditorGuard} from '../components/NavigationGuard';
import {
  api,
  useApi,
  type CoverageSummary,
  type ExtractResult,
  type ExtractedValue,
  type ProjectField,
  type ProjectInfoResponse,
} from '../api';
import { Bar, Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, Textarea, useAction, useToast } from '../ui';

/* ------------------------------ 字段分组 ------------------------------ */
/**
 * 字段按用途分组显示。44 个字段平铺太长，分组后更容易定位。
 * 用前缀匹配，所以 AI 新加的字段（如 supervisor_review_date）会自动落到对应组里，
 * 不需要维护一张全量清单。
 */
const GROUPS: { name: string; test: (key: string) => boolean }[] = [
  { name: '项目标识', test: (k) => /^(project_|section_|equipment_)/.test(k) },
  { name: '合同', test: (k) => /^contract_/.test(k) },
  { name: '甲方（建设/采购/委托/发包）', test: (k) => /^party_a/.test(k) },
  { name: '乙方（承包/供应/服务）', test: (k) => /^party_b/.test(k) },
  { name: '监理（工程类）', test: (k) => /^supervisor/.test(k) },
  { name: '人员', test: (k) => /(_officer|_lead|manager|handler|_pm$)/.test(k) },
  {
    name: '关键日期',
    test: (k) => /(_date$|_no$|place$|_org$)/.test(k) && !/^(party_a|party_b|supervisor|contract_)/.test(k),
  },
];

function groupOf(fieldKey: string): string {
  for (const g of GROUPS) if (g.test(fieldKey)) return g.name;
  return '其他';
}

/** 字段类型 → 输入控件与提示 */
function inputHint(f: ProjectField): string | undefined {
  const bits: string[] = [];
  if (f.hint) bits.push(f.hint);
  if (f.example && !f.hint) bits.push(`例：${f.example}`);
  if (f.type === 'date' && !f.hint) bits.push('中文写法，如 2026年9月16日');
  return bits.length ? bits.join('　·　') : undefined;
}

/** 解析「该字段的多个称谓」提示，告诉用户填一个框就够 */
function aliasTip(f: ProjectField): string | undefined {
  if (!f.aliases_label) return undefined;
  try {
    const arr = JSON.parse(f.aliases_label) as string[];
    if (!Array.isArray(arr) || arr.length < 2) return undefined;
    return `填这一项，${arr.join(' / ')} 都通`;
  } catch {
    return undefined;
  }
}

/* ============================== 主组件 ============================== */

export function ProjectInfoTab({ workbenchId, workTypeId }: { workbenchId: number; workTypeId: number }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const info = useApi<ProjectInfoResponse>(`/api/archive/values/${workbenchId}`);
  /**
   * 这一类工作的「模板变量映射覆盖率」（只在 <60% 时提示一句）。
   *
   * 为什么在这里说：模板里那些还没映射的 {变量}，用户在这一页是**看不到对应输入框**的，
   * 于是每出一份文书都要手打一遍。点明「有这回事 + 去哪补」，比默默受着强。
   * 口径见 server/src/core/coverage.ts（加权口径，含通用模板）。
   */
  const coverage = useApi<CoverageSummary>(`/api/coverage?workTypeId=${workTypeId}&top=1`);
  const draftKey='workbench:archive-draft:'+workbenchId;
  const [draft,setDraft]=useState<Record<string,string>>(()=>{try{return JSON.parse(sessionStorage.getItem(draftKey) ?? '{}') as Record<string,string>;}catch{return {};}});
  const dirty=Object.keys(draft).length>0;
  useEffect(()=>{try{if(dirty)sessionStorage.setItem(draftKey,JSON.stringify(draft));else sessionStorage.removeItem(draftKey);}catch{/* 存储不可用时仍可编辑 */}},[draft,draftKey,dirty]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return ()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  /** 从资料抽取的结果，非空时弹确认框 */
  const [extracted, setExtracted] = useState<ExtractResult | null>(null);
  /**
   * 抽取值与「未保存的手工草稿」撞车时的待确认项（见 writeAccepted / ExtractConflictModal）。
   * 非空 = 用户点了「写入」，但有一批字段他手改过还没保存 —— 先把选择权交回给他，绝不静默覆盖。
   */
  const [conflictAsk, setConflictAsk] = useState<{ accepted: Record<string, string>; conflicted: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const values = info.data?.values ?? {};
  const fields = info.data?.fields ?? [];
  /** 显示值 = 本地草稿优先，其次已存值 */
  const shown = (key: string): string => (key in draft ? (draft[key] ?? '') : (values[key] ?? ''));
  const setValue = (key: string, v: string) => {
    setDraft((d) => ({ ...d, [key]: v }));

  };

  /** 落盘当前草稿。抽取值确认后也走这里，避免两套写入路径 */
  const flush = async () => {
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft)) patch[k] = v;
    if (Object.keys(patch).length) await api.put(`/api/archive/values/${workbenchId}`, { values: patch });
    setDraft(current=>JSON.stringify(current)===JSON.stringify(patch)?{}:current);
    info.reload();
  };
  useEditorGuard({dirty,busy,save:flush,discard:()=>{setDraft({});sessionStorage.removeItem(draftKey);}});

  /** 字段标识 → 显示名：提示里点名"哪几项"时给人看的是这个，不是英文键 */
  const labelOf = (key: string) => fields.find((f) => f.field_key === key)?.label ?? key;

  /**
   * 落盘「确认过的抽取值」，并**只清掉这批被写入字段的草稿**。
   *
   * 「被写入的字段」的界定：确认框回传的 `accepted` 的键本身 —— `ExtractPreviewModal.doConfirm()`
   * 只放"勾选了、且值非空"的项，服务端 `confirmExtraction()` 也只写这些键（一次事务：要么全写、
   * 要么整体报错），所以键集合 = 这次真的落库的字段集合，不需要再猜。
   *
   * 清草稿时只 `delete` 这些键：用户在别的字段上手工改过、还没保存的内容一律留着 ——
   * 否则"自动填写"就成了"顺手清掉别人所有未保存修改"。
   *
   * `keptDraft` = 用户在冲突框里选了「保留我的修改」而**没有**写库的键。它们的草稿是用户自己打的字，
   * 必须继续留着（留着 = 不丢），提示里如实点名。
   *
   * sessionStorage 不用单独处理：草稿的镜像 useEffect（依赖 `[draft,draftKey,dirty]`）会在草稿变化时
   * 覆盖写、草稿空了就 removeItem —— 清理与草稿走同一条路，所以跨路由返回也不会"复活"。
   */
  const writeAccepted = async (accepted: Record<string, string>, writtenKeys: string[], keptDraft: string[] = []) => {
    if (writtenKeys.length) await api.post('/api/archive/extract/confirm', { workbenchId, accepted });
    setConflictAsk(null);
    setExtracted(null);
    setDraft((d) => {
      const next = { ...d };
      for (const k of writtenKeys) delete next[k];
      return next;
    });
    info.reload();
    if (!writtenKeys.length) {
      toast(`${keptDraft.length} 项你有未保存的修改，已保留你的值、没有写入抽取结果：${keptDraft.map(labelOf).join('、')}`, 'info');
      return;
    }
    toast(
      keptDraft.length
        ? `已写入 ${writtenKeys.length} 项；另外 ${keptDraft.length} 项你有未保存的修改，已保留你的值、未写入：${keptDraft.map(labelOf).join('、')}`
        : `已写入 ${writtenKeys.length} 项`,
      'ok',
    );
  };

  const grouped = useMemo(() => {
    const m = new Map<string, ProjectField[]>();
    for (const f of fields) {
      const g = groupOf(f.field_key);
      if (!m.has(g)) m.set(g, []);
      (m.get(g) as ProjectField[]).push(f);
    }
    // 按 GROUPS 顺序输出，未知组排最后
    return [...m.entries()].sort((a, b) => {
      const ia = GROUPS.findIndex((g) => g.name === a[0]);
      const ib = GROUPS.findIndex((g) => g.name === b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [fields]);

  const filledCount = fields.filter((f) => shown(f.field_key).trim() !== '').length;
  const missingRequired = fields.filter((f) => f.required && shown(f.field_key).trim() === '');

  const save = () =>
    run(async () => {
      await flush();
      toast('项目信息已保存', 'ok');
    });

  /** 选一份资料，让模型读一遍把字段抽出来（不落盘，先给你确认） */
  const pickAndExtract = (file: File) =>
    run(async () => {
      const fd = new FormData();
      fd.append('workbenchId', String(workbenchId));
      fd.append('files', file);
      const r = await api.upload<ExtractResult>('/api/archive/extract/upload', fd);
      if (!r.ok) throw { message: r.error ?? '没能从这份资料里读出可用的信息' };
      setExtracted(r);
      if (r.items.length === 0) toast('这份资料里没有找到可用信息 —— 可能内容不匹配，或文件是扫描件', 'info');
    });

  if (info.loading) return <Loading text="正在读取项目信息…" />;
  if (info.error) return <Empty text={`读取失败：${info.error.message}`} />;
  if (!fields.length)
    return (
      <Empty
        text="这个工作类型还没有定义「项目信息」字段。可以到「流程规范 → 项目信息」里添加，或让模型读一遍模板自动梳理。"
      />
    );

  return (
    <div>
      <Card
        title="项目信息"
        extra={
          <div className="row" style={{ gap: 8 }}>
            {dirty && <Tag kind="warn">有未保存的修改</Tag>}
            <input
              ref={fileRef}
              type="file"
              accept=".docx,.xlsx,.pdf,.txt,.md"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) pickAndExtract(f);
              }}
            />
            <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()} title="选一份合同或批复，让模型读出字段值">
              {busy ? '读取中…' : '从资料自动填写'}
            </Button>
            <Button kind={dirty ? 'primary' : 'default'} size="sm" disabled={!dirty || busy} onClick={save}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          这些是这个项目的固定信息 —— 填一次，之后生成任何文书都会自动带出，不必重复输入。
          每个字段可能在不同文书里有不同叫法（如甲方也叫发包人 / 采购单位 / 委托方），填一个框即可。
          <br />
          手上有合同或批复时，点「从资料自动填写」，模型会读一遍把值连出处一起提出来，你确认后才落盘。
        </p>

        <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <Bar value={filledCount} max={fields.length} />
          </div>
          <span className="small">
            已填 <strong>{filledCount}</strong> / {fields.length} 项
            {missingRequired.length > 0 && (
              <>
                　·　必填还缺 <strong style={{ color: 'var(--err)' }}>{missingRequired.length}</strong> 项
              </>
            )}
          </span>
        </div>

        {missingRequired.length > 0 && (
          <div className="notice notice-warn">
            必填未填：{missingRequired.map((f) => f.label).join('、')}
          </div>
        )}

        {coverage.data && coverage.data.totalVars > 0 && coverage.data.percent < 60 && (
          <div className="notice notice-info mt12">
            这一类的模板变量映射覆盖率只有 <strong>{coverage.data.percent}%</strong>
            （{coverage.data.mappedVars}/{coverage.data.totalVars} 处能自动带出）——
            模板里还有不少 {'{变量}'} 没有对应的项目信息字段或别名，出文书时得手填或让模型写。
            需不需要补，到「知识库 → 模板库 → 模板变量覆盖率」看未映射清单（按出现次数排序，还带建议别名）。
          </div>
        )}
      </Card>

      {grouped.map(([groupName, items]) => (
        <Card key={groupName} title={groupName} collapsible>
          <div className="grid-2">
            {items.map((f) => (
              <Field
                key={f.field_key}
                label={
                  <>
                    {f.label}
                    {f.seed ? <span className="muted small">（常用）</span> : null}
                  </>
                }
                required={Boolean(f.required)}
                hint={
                  <>
                    {inputHint(f)}
                    {aliasTip(f) && (
                      <>
                        <br />
                        <span className="muted">{aliasTip(f)}</span>
                      </>
                    )}
                  </>
                }
              >
                {f.type === 'longtext' ? (
                  <Textarea value={shown(f.field_key)} onChange={(v) => setValue(f.field_key, v)} rows={3} />
                ) : (
                  <Input
                    value={shown(f.field_key)}
                    onChange={(v) => setValue(f.field_key, v)}
                    placeholder={f.example ?? ''}
                    type={f.type === 'money' || f.type === 'number' || f.type === 'percent' ? 'text' : 'text'}
                  />
                )}
              </Field>
            ))}
          </div>
        </Card>
      ))}

      {dirty && (
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <Button kind="primary" disabled={busy} onClick={save}>
            {busy ? '保存中…' : '保存项目信息'}
          </Button>
          <Button
            onClick={() => {
              setDraft({});
            }}
          >
            放弃修改
          </Button>
        </div>
      )}

      {extracted && (
        <ExtractPreviewModal
          result={extracted}
          drafts={draft}
          onClose={() => setExtracted(null)}
          onConfirm={(accepted) =>
            run(async () => {
              const written = Object.keys(accepted);
              /**
               * 这批键里有"用户手改过、还没保存"的（草稿优先于库里的值）→ **先问再写**，不静默覆盖。
               *
               * 为什么不能照旧直接写：写库只改库，输入框读的是草稿 —— 库里变成新值、输入框还是旧值，
               * 用户再点一次保存就把新值冲掉（静默数据丢失，正是这次要修的缺陷）。
               * 为什么也不直接丢草稿：那是用户自己打的字。所以把两个值都摆出来让他选。
               */
              const conflicted = written.filter((k) => (draft[k] ?? '').trim() !== accepted[k]);
              if (conflicted.length) {
                setConflictAsk({ accepted, conflicted });
                return;
              }
              await writeAccepted(accepted, written);
            })
          }
        />
      )}

      {conflictAsk && (
        <ExtractConflictModal
          accepted={conflictAsk.accepted}
          conflicted={conflictAsk.conflicted}
          drafts={draft}
          labelOf={labelOf}
          onCancel={() => setConflictAsk(null)}
          onKeepMine={() =>
            run(async () => {
              const keep = new Set(conflictAsk.conflicted);
              const toWrite: Record<string, string> = {};
              for (const [k, v] of Object.entries(conflictAsk.accepted)) if (!keep.has(k)) toWrite[k] = v;
              /** 只写没冲突的那些；被保留的键不写库，它们的草稿继续留着 */
              await writeAccepted(toWrite, Object.keys(toWrite), conflictAsk.conflicted);
            })
          }
          onTakeNew={() =>
            run(async () => {
              const all = Object.keys(conflictAsk.accepted);
              /** 采用资料里的新值 = 全部写库；被覆盖字段的草稿此时必须清掉，否则又回到"库新框旧" */
              await writeAccepted(conflictAsk.accepted, all);
            })
          }
        />
      )}
    </div>
  );
}

/* ============================== 抽取结果确认 ============================== */

const CONF_CN: Record<string, string> = { high: '高', medium: '中', low: '低' };

/**
 * 抽取结果确认框。
 *
 * 这是「AI 只提案、你确认才落盘」原则在抽取上的落点 —— 模型读错一个数字，
 * 这里能看出来（有出处）也能改掉，不会悄悄写进项目信息。
 *
 * `drafts` = 调用方（ProjectInfoTab）当前的未保存草稿。**必须传**：
 * 输入框显示的是「草稿优先」的值，只看库里的 `it.current` 会漏掉"用户手改过还没保存"这种冲突，
 * 于是确认框上写着"与已有值不同，写入将覆盖"却完全没提用户自己的修改 —— 那才是会丢的东西。
 */
function ExtractPreviewModal({
  result,
  drafts,
  onClose,
  onConfirm,
}: {
  result: ExtractResult;
  drafts: Record<string, string>;
  onClose: () => void;
  onConfirm: (accepted: Record<string, string>) => void;
}) {
  /** 字段 → 是否采纳；默认采纳高置信度的，中低置信度默认不勾（让用户自己判断） */
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {};
    for (const it of result.items) m[it.field_key] = it.confidence === 'high';
    return m;
  });
  /** 字段 → 编辑后的值（用户可在确认前改掉抽错的内容） */
  const [edited, setEdited] = useState<Record<string, string>>({});
  const valueOf = (it: ExtractedValue) => (it.field_key in edited ? (edited[it.field_key] ?? '') : it.value);

  const acceptedCount = result.items.filter((it) => checked[it.field_key] && valueOf(it).trim() !== '').length;
  const conflictCount = result.items.filter((it) => it.current && it.current !== it.value).length;

  const doConfirm = () => {
    const accepted: Record<string, string> = {};
    for (const it of result.items) {
      if (checked[it.field_key] && valueOf(it).trim() !== '') accepted[it.field_key] = valueOf(it).trim();
    }
    onConfirm(accepted);
  };

  return (
    <Modal
      open
      wide
      title="从资料里读到的信息 —— 确认后写入项目信息"
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {result.summary ? `模型判断：${result.summary}` : ''}
            {result.textInfo.truncated && '（资料较长，只读了开头和结尾）'}
          </span>
          <Button onClick={onClose}>取消</Button>
          <Button kind="primary" disabled={acceptedCount === 0} onClick={doConfirm}>
            写入选中的 {acceptedCount} 项
          </Button>
        </div>
      }
    >
      {result.items.length === 0 ? (
        <Empty text="这份资料里没有找到可用的信息。可能是内容不匹配，或者文件是扫描件（需要先 OCR）。" />
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            模型只抽资料里明确写着的内容，每条都标了出处。请核对后勾选要写入的项 ——
            <strong>抽错的值直接在这里改</strong>，改完再写入。
            {conflictCount > 0 && `　⚠ 有 ${conflictCount} 项与项目信息里已有的值不同。`}
          </p>

          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <Button size="sm" onClick={() => setChecked(Object.fromEntries(result.items.map((it) => [it.field_key, true])))}>
              全选
            </Button>
            <Button size="sm" onClick={() => setChecked({})}>
              全不选
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setChecked(Object.fromEntries(result.items.map((it) => [it.field_key, it.confidence === 'high'])))
              }
            >
              只选高置信度
            </Button>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}> </th>
                <th>字段</th>
                <th>读到 / 当前</th>
                <th>出处</th>
                <th style={{ width: 56 }}>把握</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((it) => {
                const on = Boolean(checked[it.field_key]);
                const conflict = it.current && it.current !== it.value;
                /** 这一项在输入框里还有用户的未保存修改（草稿优先），且与将被写入的值不同 */
                const myDraft = it.field_key in drafts ? (drafts[it.field_key] ?? '') : null;
                const myDraftConflict = myDraft !== null && myDraft.trim() !== valueOf(it).trim();
                return (
                  <tr key={it.field_key} style={on ? undefined : { opacity: 0.5 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => setChecked((c) => ({ ...c, [it.field_key]: e.target.checked }))}
                      />
                    </td>
                    <td>
                      <strong>{it.label}</strong>
                      <div className="muted small mono">{it.field_key}</div>
                    </td>
                    <td>
                      <Input value={valueOf(it)} onChange={(v) => setEdited((x) => ({ ...x, [it.field_key]: v }))} />
                      {conflict && (
                        <div className="small" style={{ marginTop: 4 }}>
                          <span className="muted">库里现在是：{it.current}</span>
                          <br />
                          <span style={{ color: 'var(--warn)' }}>与库里的值不同，写入会覆盖库里的值</span>
                        </div>
                      )}
                      {myDraftConflict && (
                        <div className="small" style={{ marginTop: 4, color: 'var(--warn)' }}>
                          这一项你有未保存的修改（输入框里是「{myDraft}」）—— 写入前会先问你保留哪一个，不会静默覆盖
                        </div>
                      )}
                    </td>
                    <td className="small muted">{it.source}</td>
                    <td>
                      <Tag kind={it.confidence === 'high' ? 'ok' : it.confidence === 'low' ? 'err' : 'warn'}>
                        {CONF_CN[it.confidence]}
                      </Tag>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {result.notFound.length > 0 && (
            <p className="muted small" style={{ marginBottom: 0 }}>
              资料里没提到的字段（{result.notFound.length} 个）：{result.notFound.join('、')}
              <br />
              这些需要你另外补，或从别的资料里抽。
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/* ------------------- 抽取值 vs 未保存的手工修改：先问再写 ------------------- */

/**
 * 「抽取值」与「未保存的手工修改」撞在同一字段上 —— 先问一句，再决定写谁。
 *
 * 为什么会撞上：输入框显示的是**草稿优先**的值（`shown()`），用户手改后没点保存；
 * 这时从资料里抽到同一字段的新值并确认写入，两个值只能留一个：
 *   · 只写库、不清草稿 → 库里是新值、输入框还是旧值，用户再点保存就把新值冲掉（**静默丢数据**）；
 *   · 直接丢掉草稿     → 丢掉用户自己打的字。
 * 两条都不该由程序替他选，所以把「你的未保存修改」和「资料里读到的值」并排摆出来让他选。
 */
function ExtractConflictModal({
  accepted,
  conflicted,
  drafts,
  labelOf,
  onCancel,
  onKeepMine,
  onTakeNew,
}: {
  accepted: Record<string, string>;
  /** 与草稿冲突的字段键（本次真正要写的键 ∩ 有草稿的键） */
  conflicted: string[];
  drafts: Record<string, string>;
  labelOf: (key: string) => string;
  onCancel: () => void;
  onKeepMine: () => void;
  onTakeNew: () => void;
}) {
  return (
    <Modal
      open
      wide
      title={`这 ${conflicted.length} 项你有未保存的修改 —— 保留哪一个？`}
      onClose={onCancel}
      footer={
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button onClick={onCancel}>取消</Button>
          <Button kind="primary" onClick={onKeepMine} title="这些字段不写库，你的输入框保持原样（仍是未保存状态）">
            保留我的修改（这些字段不写入）
          </Button>
          <Button kind="danger" onClick={onTakeNew} title="这些字段写库，同时丢掉你在这些字段上的未保存修改">
            采用资料里的新值（丢弃我的修改）
          </Button>
        </div>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        下面这些字段你在输入框里改过、还没点保存；这次从资料里抽取也在同一字段上读到了值。
        两者只能留一个，所以先问一句 —— <strong>其余勾选的字段不受影响，照常写入</strong>。
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>字段</th>
            <th>你的未保存修改（输入框里现在显示的）</th>
            <th>资料里读到的值</th>
          </tr>
        </thead>
        <tbody>
          {conflicted.map((k) => (
            <tr key={k}>
              <td>
                <strong>{labelOf(k)}</strong>
                <div className="muted small mono">{k}</div>
              </td>
              <td>{drafts[k] ?? ''}</td>
              <td>{accepted[k]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small" style={{ marginBottom: 0 }}>
        「保留我的修改」选完，这些字段仍是未保存状态（页面上「有未保存的修改」的标记还在），
        你可以接着改、或者点「保存」把它们写进项目信息。
      </p>
    </Modal>
  );
}

/**
 * 项目信息字段管理 —— 增删改字段定义。
 * 放在「流程规范」页里，按工作类型配置。
 */
export function ProjectFieldsEditor({ workTypeId }: { workTypeId: number }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const list = useApi<{ items: ProjectField[] }>(`/api/archive/fields?workTypeId=${workTypeId}`);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ fieldKey: '', label: '', type: 'text', hint: '', example: '', required: false });

  const items = list.data?.items ?? [];

  const create = () =>
    run(async () => {
      if (!/^[a-z][a-z0-9_]*$/.test(form.fieldKey)) {
        throw { message: '字段标识只能用英文小写字母、数字、下划线，且以字母开头' };
      }
      await api.post('/api/archive/fields', {
        workTypeId,
        fieldKey: form.fieldKey,
        label: form.label || form.fieldKey,
        type: form.type,
        hint: form.hint || undefined,
        example: form.example || undefined,
        required: form.required,
      });
      setForm({ fieldKey: '', label: '', type: 'text', hint: '', example: '', required: false });
      setAdding(false);
      list.reload();
      toast('字段已添加', 'ok');
    });

  const remove = (f: ProjectField) =>
    run(async () => {
      /**
       * `DELETE /api/archive/fields/:id` → `archiveField()`（domain/archive.ts）：它走
       * `core/trash.ts` 的 `markDeleted()` 写 `deleted_at`，同时写 `archived_at`（旧读路径按后者过滤），
       * 所以这一刀就是**移入回收站**，用户在回收站页能恢复、也能彻底删除。
       * 文案因此可以明确承诺「会移到回收站、可在回收站恢复」，并指路彻底删除的位置。
       */
      await api.del(`/api/archive/fields/${f.id}`);
      list.reload();
      toast(`已移除字段「${f.label}」：字段会移到回收站，可在「回收站」页恢复（要彻底删除也请到「回收站」页）`, 'ok');
    });

  const rename = (f: ProjectField, label: string) =>
    run(async () => {
      await api.put(`/api/archive/fields/${f.id}`, { label });
      list.reload();
    });

  if (list.loading) return <Loading />;

  return (
    <Card
      title={`项目信息字段（${items.length}）`}
      extra={
        <Button size="sm" kind={adding ? 'default' : 'primary'} onClick={() => setAdding((a) => !a)}>
          {adding ? '取消' : '+ 添加字段'}
        </Button>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        字段标识（英文）是稳定的契约，一旦有模板变量映射过来就不能改；显示名称随时可改。
      </p>

      {adding && (
        <div className="grid-2" style={{ marginBottom: 12 }}>
          <Field label="字段标识（英文）" required hint="如 supervisor_org">
            <Input value={form.fieldKey} onChange={(v) => setForm({ ...form, fieldKey: v })} placeholder="supervisor_org" />
          </Field>
          <Field label="显示名称" required hint="如 监理机构">
            <Input value={form.label} onChange={(v) => setForm({ ...form, label: v })} placeholder="监理机构" />
          </Field>
          <Field label="类型">
            <Select
              value={form.type}
              onChange={(v) => setForm({ ...form, type: v })}
              options={[
                { value: 'text', label: '短文本' },
                { value: 'longtext', label: '长文本' },
                { value: 'date', label: '日期' },
                { value: 'money', label: '金额' },
                { value: 'number', label: '数字' },
                { value: 'percent', label: '比例' },
                { value: 'enum', label: '选项' },
              ]}
            />
          </Field>
          <Field label="示例值">
            <Input value={form.example} onChange={(v) => setForm({ ...form, example: v })} />
          </Field>
          <Field label="填写提示">
            <Input value={form.hint} onChange={(v) => setForm({ ...form, hint: v })} />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Button kind="primary" disabled={busy} onClick={create}>
              添加
            </Button>
          </div>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>显示名称</th>
            <th>字段标识</th>
            <th>类型</th>
            <th>来源</th>
            <th> </th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr key={f.id}>
              <td>
                <Input
                  value={f.label}
                  onChange={(v) => rename(f, v)}
                />
              </td>
              <td className="mono small">{f.field_key}</td>
              <td className="small">{f.type}</td>
              <td>
                {f.seed ? <Tag kind="info">常用</Tag> : f.origin === 'ai' ? <Tag kind="warn">AI 梳理</Tag> : <Tag>自建</Tag>}
              </td>
              <td style={{ textAlign: 'right' }}>
                {f.seed ? (
                  <span className="muted small">不可删</span>
                ) : (
                  <Button
                    size="sm"
                    kind="danger"
                    title="把字段移到回收站（不再出现在项目信息里，可在回收站恢复）"
                    onClick={() => {
                      /**
                       * 后端这一步是**移入回收站**（`archiveField()` → `markDeleted()` 写 `deleted_at`，
                       * 同时写 `archived_at` 照顾旧读路径），所以确认框可以明确承诺"可在回收站恢复"。
                       * 真正不可恢复的那一步是回收站页里的「彻底删除」（`DELETE /api/trash/field/:id`），
                       * 这里把这条指路写清楚，用户不会以为点「移除」等于删干净。
                       */
                      if (
                        !window.confirm(
                          `确定移除字段「${f.label}」？\n\n字段会移到回收站，可在「回收站」页恢复；要彻底删除请到「回收站」页操作。`,
                        )
                      )
                        return;
                      void remove(f);
                    }}
                  >
                    移除
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
