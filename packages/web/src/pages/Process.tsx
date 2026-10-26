import {LoadError} from '../components/DesignSystem';
import { WorkTypeEditor } from '../components/WorkTypeEditor';
import {useUnsavedClose} from '../components/useUnsavedClose';
import { TYPE_GROUPS, type NavigationGroup } from '../work-type-navigation';
import '../work-type-navigation.css';
import { useState } from 'react';
import {
  api,
  useApi,
  type EvidenceRule,
  type FolderSubdir,
  type MaterialRule,
  type PositionDocBinding,
  type PositionDocCandidate,
  type PositionRule,
  type Workbench,
  type WorkType,
} from '../api';
import { Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, Textarea, useAction, useToast } from '../ui';

/** A 型默认期次格式（契约 §12.3：年份一层、月份一层）→ `2026\10月` */
const DEFAULT_PERIOD_FORMAT = '{yyyy}\\{mm}月';

/** 目录名下拉里「＋ 新建目录」这一项的值（不会与真实目录名相同：Windows 文件名不能含 `<>`） */
const NEW_DIR = '<新建>';

/**
 * 期次格式串的合法性检查（契约 §12.3）。
 *
 * 与后端 `core/period-dir.ts` 的 `periodSpecProblem` 同一套规则、同一套提示语：
 * 拒 `..`、盘符 / UNC 绝对路径、`: * ? " < > |` 与控制字符、`.` 层级。
 *
 * **必须在前端也查一遍**：这里保存走 `/api/position-templates`，那条路由把 periodDir
 * 原样入库（只有 `PUT /api/positions/:id` 才经过 `setPositionPeriodDir` 的校验）。
 * 不查的话会存进一个"当时不报错、以后落盘才炸"的格式（`positionPeriodDirAbs` 会抛
 * 「期次目录越界，拒绝使用」），那时用户根本联系不到这次编辑。
 */
function periodFormatProblem(spec: string): string | null {
  const raw = (spec ?? '').trim();
  if (!raw) return null; // 空 = 用默认 A 型，不算错
  const asPath = raw.replace(/\//g, '\\');
  if (raw.includes('..')) return '期次目录格式不能含 `..`（上级跳转）';
  if (/^[A-Za-z]:/.test(raw)) return '期次目录格式不能是绝对路径（不能以盘符开头，如 `C:...`）';
  if (asPath.startsWith('\\\\')) return '期次目录格式不能是 UNC 绝对路径（不能以 `\\\\` 开头）';
  if (/[:*?"<>|\r\n\t]/.test(raw)) return '期次目录格式含有非法字符（不能有 : * ? " < > |）';
  for (const seg of asPath.split('\\')) {
    if (seg.trim() === '.') return '期次目录格式的层级名不能是 `.`';
  }
  return null;
}

/**
 * 自己新建的目录名检查（§12.1）。
 *
 * 后端落盘时会用 `safeName` 静默清洗非法字符 —— 清洗掉字符就等于**换了目录名**，
 * 文件落到别处正是最难查的一类问题（§10 开头）。所以这里宁可先拦住，让用户改。
 * 返回 null = 通过。
 */
function folderNameProblem(name: string): string | null {
  const n = (name ?? '').trim();
  if (!n) return '新目录名不能为空，或者选「不设置」用默认的「序号_阶段名」';
  if (/[\\/:*?"<>|]/.test(n)) return '目录名不能用这些字符：\\ / : * ? " < > |';
  if (n !== name) return '目录名首尾不能有空格';
  if (n.startsWith('.') || n.endsWith('.')) return '目录名首尾不能有点';
  if (n.includes('..')) return '目录名不能含 `..`';
  return null;
}

export default function ProcessPage() {
  const toast = useToast();
  const types = useApi<{ items: WorkType[] }>('/api/work-types?includeArchived=1');
  const [expandedGroup, setExpandedGroup] = useState<NavigationGroup | null>(null);
  const [activeType, setActiveType] = useState<number | null>(null);
  const currentType = activeType;
  const positions = useApi<{ items: PositionRule[] }>(currentType ? `/api/position-templates?workTypeId=${currentType}` : null, [currentType]);
  const [editingPos, setEditingPos] = useState<PositionRule | 'new' | null>(null);
  const [ruleModal, setRuleModal] = useState<{ kind: 'material' | 'evidence'; positionId: number; rule?: MaterialRule | EvidenceRule } | null>(null);
  /**
   * 「本阶段文书模板」绑定弹窗（B2-7）。
   *
   * 与材料/影像规则用同一个思路：卡片上**只读地**显示当前绑定（好让人一眼看出
   * "这个阶段该出哪些文书"），改动集中在弹窗里一次提交 —— 多选 + 「必须出具」是
   * 一组要一起定下来的配置，逐项即时保存会让中间状态反复入库。
   */
  const [docModal, setDocModal] = useState<PositionRule | null>(null);

  const type = types.data?.items.find((t) => t.id === currentType);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="notice notice-info">
        <strong>这里是流程的"标准答案"。</strong> 你改这里，之后所有新建的工作台都会按新流程生成目录和清单；
        已有工作保留快照；「追加缺失阶段」只补新阶段，不覆盖已有清单、顺序或目录。
      </div>

      <div className="page-split">
        <Card title="工作类型">
          {types.loading ? (
            <Loading />
          ) : types.error ? <LoadError error={types.error} retry={types.reload}/> : (
            <div className="list-nav">
              {TYPE_GROUPS.map(group => {
                const items = (types.data?.items ?? []).filter(t => t.navigation_group === group.value);
                return <section key={group.value} className="type-group">
                  <button type="button" className="type-group-heading" aria-expanded={expandedGroup === group.value} onClick={() => setExpandedGroup(expandedGroup === group.value ? null : group.value)}>
                    <span>{expandedGroup === group.value ? '▾' : '▸'} {group.label}</span><span className="muted small">{items.length}</span>
                  </button>
                  {expandedGroup === group.value && <div className="type-group-list">
                    {items.map(t => <button type="button" key={t.id} className={`type-list-item${t.id === currentType ? ' active' : ''}`} onClick={() => setActiveType(t.id)}>
                      <span>{t.display_name}</span><span className="small muted">{t.archived_at ? '已停用' : t.mode === 'process' ? `${t.position_count} 个阶段` : '文书 / 事务'}</span>
                    </button>)}
                    {!items.length && <p className="small muted">暂无工作类型</p>}
                    <WorkTypeEditor defaultGroup={group.value} onDone={(id,savedGroup) => { types.reload(); setActiveType(id); if(savedGroup)setExpandedGroup(savedGroup); }} />
                  </div>}
                </section>;
              })}
              {(types.data?.items ?? []).some(t => !t.navigation_group) && <div className="notice notice-warn">
                <strong>待确认归属</strong><p className="small">以下类型仍可查看和编辑，确认分类后可在新建工作中选择。</p>
                {(types.data?.items ?? []).filter(t => !t.navigation_group).map(t => <button type="button" key={t.id} className="type-list-item" onClick={() => setActiveType(t.id)}>{t.display_name}{t.archived_at ? '（已停用）' : ''}</button>)}
              </div>}
            </div>
          )}
        </Card>

        <div className="col" style={{ gap: 14 }}>
          {!type ? <><h3>全部流程规范</h3>{types.error?<div role="alert" className="notice notice-err">{types.error.message}<Button onClick={types.reload}>重试</Button></div>:(types.data?.items??[]).filter(t=>!t.archived_at).map(t=><Card key={t.id} title={t.display_name||t.name} extra={<Button size="sm" onClick={()=>{setActiveType(t.id);setExpandedGroup(t.navigation_group??null);}}>查看 / 编辑</Button>}><p>{t.description||'选择具体类型查看办理规则与模板。'}</p><div className="row"><Tag>{TYPE_GROUPS.find(g=>g.value===t.navigation_group)?.label??'待确认分类'}</Tag><span className="small muted">{t.mode==='process'?t.position_count+' 个阶段':'独立期次 / 文书办理'} · 规则 v{t.rule_version}</span></div></Card>)}</> : <Card
            title={`${type.display_name} 的执行流程${type.archived_at ? '（已停用）' : ''}`}
            extra={
              <>
                <span className="small muted">{type?.domain==='project'?'项目实施':'行政管理'} / {type?.category} · 规则 v{type?.rule_version}</span>
                <WorkTypeEditor key={`${type.id}-${type.rule_version}`} type={type} onDone={(_id,group)=>{ types.reload(); if(group)setExpandedGroup(group); }}/>
                <Button size="sm" kind="primary" disabled={type?.mode!=='process'} onClick={() => setEditingPos('new')}>
                  ＋ 新增阶段
                </Button>
              </>
            }
          >
            {type?.mode==='document' && <p>此类型按文书或简单事务办理，可在「编辑类型与默认规则」配置周期和每期材料。阶段式工作请选择「阶段流程」。</p>}
            {type?.description && <div className="notice mb12">{type.description}</div>}
            {positions.loading ? (
              <Loading />
            ) : positions.error ? <LoadError error={positions.error} retry={positions.reload}/> : (positions.data?.items.length ?? 0) === 0 ? (
              <Empty text="这个工作类型还没有配置阶段。" action={<Button onClick={() => setEditingPos('new')}>新增第一个阶段</Button>} />
            ) : (
              <div className="col" style={{ gap: 12 }}>
                {positions.data?.items.map((p) => (
                  <div key={p.id} className="card" style={{ boxShadow: 'none' }}>
                    <div className="card-head">
                      <h3>
                        <span className="step-dot" style={{ width: 20, height: 20, fontSize: 11 }}>
                          {p.seq}
                        </span>
                        {p.name}
                      </h3>
                      <div className="card-extra">
                        {p.duration_hint && <span className="small muted">建议 {p.duration_hint}</span>}
                        <span className="small muted">
                          目录 {p.folder_name}
                          {p.period_dir ? ` · 按期次 ${p.period_dir}` : ''}
                        </span>
                        <Button size="sm" onClick={() => setEditingPos(p)}>
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          kind="danger"
                          title="把这个阶段从流程里收起来（归档：配置还在库里，数据不删）"
                          onClick={async () => {
                            /**
                             * `DELETE /api/position-templates/:id`（routes-work.ts）走的是
                             * `UPDATE position_template SET archived_at = ...` —— **归档**，
                             * 不是回收站那条软删除（回收站的 `position` 指的是工作台里的阶段实例）。
                             * 文案说「归档」而不是「移到回收站」：这页不是删除入口，
                             * 而且它确实既没进回收站、也不能在回收站里恢复。
                             */
                            try {
                              await api.del(`/api/position-templates/${p.id}`);
                              toast('已归档该阶段：从流程里收起来了，配置还在库里', 'ok');
                              positions.reload();
                            } catch (e) {
                              toast((e as { message: string }).message, 'err');
                            }
                          }}
                        >
                          归档
                        </Button>
                      </div>
                    </div>
                    <div className="card-body">
                      {p.description && <div className="small muted mb8">{p.description}</div>}
                      <div className="grid grid-2">
                        <div>
                          <div className="row mb8">
                            <strong className="small">材料清单（{p.materials.length}）</strong>
                            <div className="spacer" />
                            <Button size="sm" kind="ghost" onClick={() => setRuleModal({ kind: 'material', positionId: p.id })}>
                              ＋ 加一项
                            </Button>
                          </div>
                          {p.materials.length === 0 ? (
                            <div className="small muted">还没有配置材料</div>
                          ) : (
                            <div className="col" style={{ gap: 5 }}>
                              {p.materials.map((m) => (
                                <div key={m.id} className="row small" style={{ gap: 6 }}>
                                  <span className="clickable" onClick={() => setRuleModal({ kind: 'material', positionId: p.id, rule: m })}>
                                    {m.name}
                                  </span>
                                  {m.required ? <Tag kind="warn">必需</Tag> : <Tag>选备</Tag>}
                                  <div className="spacer" />
                                  <button
                                    className="icon-btn"
                                    title="删除这项材料要求"
                                    onClick={async () => {
                                      /**
                                       * `DELETE /api/rules/:kind/:id` → `deleteRule()` 里是**真删**
                                       * （`DELETE FROM material_check`），没有回收站这一说：
                                       * 材料/影像规则不在 `TrashKind` 的五张表里，删掉恢复不了。
                                       * 所以这里保留「不可恢复」的措辞，并按项目约定加一道二次确认。
                                       */
                                      if (!window.confirm(`确定删除材料要求「${m.name}」？\n\n这项配置会从流程里真正删掉，不可恢复。`))
                                        return;
                                      try {
                                        await api.del(`/api/rules/material/${m.id}`);
                                        positions.reload();
                                        toast('已删除这项材料要求（不可恢复）', 'ok');
                                      } catch (e) {
                                        toast((e as { message: string }).message, 'err');
                                      }
                                    }}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="row mb8">
                            <strong className="small">影像清单（{p.evidences.length}）</strong>
                            <div className="spacer" />
                            <Button size="sm" kind="ghost" onClick={() => setRuleModal({ kind: 'evidence', positionId: p.id })}>
                              ＋ 加一项
                            </Button>
                          </div>
                          {p.evidences.length === 0 ? (
                            <div className="small muted">还没有配置必拍项</div>
                          ) : (
                            <div className="col" style={{ gap: 5 }}>
                              {p.evidences.map((e) => (
                                <div key={e.id} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                                  <div style={{ flex: 1 }}>
                                    <span className="clickable" onClick={() => setRuleModal({ kind: 'evidence', positionId: p.id, rule: e })}>
                                      {e.title}
                                    </span>
                                    <span className="muted"> （≥{e.min_count} 张）</span>
                                    {e.shooting_points && <div className="check-detail">{e.shooting_points}</div>}
                                  </div>
                                  <button
                                    className="icon-btn"
                                    title="删除这项影像要求"
                                    onClick={async () => {
                                      /**
                                       * 与材料要求同一个接口（`deleteRule()`，`DELETE FROM evidence_rule`）：
                                       * 真删、没有回收站、恢复不了 —— 保留「不可恢复」并二次确认。
                                       */
                                      if (!window.confirm(`确定删除影像要求「${e.title}」？\n\n这项配置会从流程里真正删掉，不可恢复。`))
                                        return;
                                      try {
                                        await api.del(`/api/rules/evidence/${e.id}`);
                                        positions.reload();
                                        toast('已删除这项影像要求（不可恢复）', 'ok');
                                      } catch (err) {
                                        toast((err as { message: string }).message, 'err');
                                      }
                                    }}
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/*
                        本阶段文书模板（B2-7）。放在材料/影像下面、同一张卡片里：
                        「这个阶段要交什么材料、拍几张照片、出哪几份文书」是同一层配置，
                        分开到别的页面用户就找不到了。
                        选项带 health_ok 徽标，坏模板在弹窗里置灰不可选。
                      */}
                      <StageDocTemplates
                        position={p}
                        onEdit={() => setDocModal(p)}
                        onChanged={() => positions.reload()}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>}
        </div>
      </div>

      {editingPos && currentType && (
        <PositionModal
          position={editingPos === 'new' ? undefined : editingPos}
          workTypeId={currentType}
          onClose={() => setEditingPos(null)}
          onSaved={() => {
            setEditingPos(null);
            positions.reload();
            types.reload();
            toast('已保存。新工作使用此配置；已有工作保持自己的目录和要求。', 'ok');
          }}
        />
      )}

      {ruleModal && (
        <RuleModal
          kind={ruleModal.kind}
          positionId={ruleModal.positionId}
          rule={ruleModal.rule}
          onClose={() => setRuleModal(null)}
          onSaved={() => {
            setRuleModal(null);
            positions.reload();
          }}
        />
      )}

      {docModal && (
        <StageDocModal
          position={docModal}
          onClose={() => setDocModal(null)}
          onSaved={() => {
            setDocModal(null);
            positions.reload();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------ 阶段↔文书模板（B2-7） ------------------------ */

/**
 * 阶段卡片上的「本阶段文书模板」只读展示。
 *
 * 为什么只读、改动放弹窗：多选 + 「必须出具」是一组要一起定下来的配置，
 * 逐项即时保存会让中间状态反复入库（勾了 3 个就已经写了 3 次）。
 * 这里必须把三件事说清楚，否则用户不知道该去哪儿配、也不知道为什么出文书时
 * 只列了这几份：
 *   ① 已绑了哪几份、哪几份标了「必须出具」；
 *   ② 一份都没绑时**明说会回退**到「该工作类型全部模板」（与改造前一致，不是坏了）；
 *   ③ 引用的模板被删除/归档时**明说**并给「重新选择」入口（不静默消失）。
 */
function StageDocTemplates({
  position,
  onEdit,
  onChanged,
}: {
  position: PositionRule;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  /**
   * 懒加载：只有展开过这个阶段的文书区才去查（一个类型下几十个阶段，
   * 一进页面就打几十个请求没必要）。展开状态由这个 state 记住。
   */
  const [open, setOpen] = useState(false);
  const doc = useApi<{ items: PositionDocBinding[]; boundIds: number[] }>(
    open ? `/api/position-templates/${position.id}/templates` : null,
    [position.id],
  );
  const items = doc.data?.items ?? [];
  const required = items.filter((i) => i.required && !i.missing).length;
  const missing = items.filter((i) => i.missing);

  return (
    <div className="mt8" style={{ borderTop: '1px solid var(--line, #e5e5e5)', paddingTop: 8 }}>
      <div className="row mb8">
        <strong className="small" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} 本阶段文书模板
          {open && doc.data ? `（${items.length}）` : ''}
        </strong>
        <div className="spacer" />
        <Button size="sm" kind="ghost" onClick={onEdit} title="选择这个阶段该用哪几个模板出文书">
          选择模板
        </Button>
      </div>

      {!open && (
        <div className="small muted">
          点标题展开，或点「选择模板」直接配置。绑过之后，这份工作里出文书只列这里的模板。
        </div>
      )}

      {open && doc.loading && <Loading text="读取本阶段的文书绑定…" />}

      {open && doc.error && (
        <div className="small" style={{ color: 'var(--err)' }}>
          读不到本阶段的文书绑定：{doc.error.message}
        </div>
      )}

      {open && doc.data && items.length === 0 && (
        <div className="small muted">
          一份都没绑 —— 出文书时会列出<strong>该工作类型的全部模板</strong>（与以前一样，不是坏掉了）。
          绑过之后就只列这里选的，避免拿错别阶段的文书。
        </div>
      )}

      {open && doc.data && items.length > 0 && (
        <div className="col" style={{ gap: 5 }}>
          {items.map((b) => (
            <div key={b.templateId} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
              <span style={{ flex: 1 }}>
                {b.name}
                {b.health_ok === 0 && (
                  <>
                    {' '}
                    <Tag kind="err">打不开</Tag>
                  </>
                )}
                {b.missing && (
                  <div className="check-detail" style={{ color: 'var(--err)' }}>
                    {b.missingReason ?? '引用的模板已删除，请重新选择'}
                  </div>
                )}
              </span>
              {b.required ? <Tag kind="warn">必须出具</Tag> : <Tag>选备</Tag>}
            </div>
          ))}
          <div className="small muted">
            应出 {items.length} 份
            {required ? `，其中必须出具 ${required} 份` : ''}
            {missing.length ? `；另有 ${missing.length} 份引用的模板已不可用，需要重新选择` : ''}
          </div>
          {missing.length > 0 && (
            <div className="row">
              <Button
                size="sm"
                kind="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    /**
                     * 「清掉引用不到的绑定」= 只删这些已失效的行，**其余绑定原样保留**。
                     * 走的是同一个 PUT（整表替换语义）：把有效的那些原样提交回去，
                     * 失效的就不提交 —— 服务端据此把它们清掉。
                     * 不做"自动换成别的模板"：换哪份只有用户知道（docs/09 §6：永不自动改）。
                     */
                    const keep = items.filter((i) => !i.missing).map((i) => ({ templateId: i.templateId, required: i.required, seq: i.seq }));
                    await api.put(`/api/position-templates/${position.id}/templates`, { items: keep });
                    toast(`已清掉 ${missing.length} 条失效的引用；其余绑定没动`, 'ok');
                    doc.reload();
                    onChanged();
                  })
                }
              >
                清掉这 {missing.length} 条失效引用
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 阶段文书模板绑定弹窗（B2-7）。
 *
 * 选项 = 该阶段所属**工作类型**的模板（含 `work_type_id IS NULL` 的通用模板），
 * 与「出文书」回退时的候选集**逐条一致** —— 在这里能选到的就是之后能用的。
 *
 * 坏模板（`bindable === false`）**置灰不可选并给出原因**（docs/11 B2-7 验收③）。
 * 服务端在 PUT 时还会再拦一道（前端置灰只是"别让你白点一次"，
 * 不是唯一防线 —— 接口可以直接被调用）。
 *
 * 保存语义是**整表替换**：这里提交的就是最终状态，空数组 = 全部解绑。
 */
function StageDocModal({
  position,
  onClose,
  onSaved,
}: {
  position: PositionRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const q = useApi<{ items: PositionDocBinding[]; boundIds: number[]; candidates: PositionDocCandidate[] }>(
    `/api/position-templates/${position.id}/templates`,
    [position.id],
  );
  /**
   * 勾选状态。`null` = 还没从接口读回来（用它区分"用户清空了"和"还没加载"，
   * 否则一进弹窗就会把已有绑定显示成"一个都没选"）。
   */
  const [picked, setPicked] = useState<{ templateId: number; required: number }[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  const bound = q.data?.items ?? [];
  const candidates = q.data?.candidates ?? [];
  const state = picked ?? bound.map((b) => ({ templateId: b.templateId, required: b.required }));
  const isPicked = (id: number) => state.some((s) => s.templateId === id);
  const toggle = (id: number) =>
    setPicked(isPicked(id) ? state.filter((s) => s.templateId !== id) : [...state, { templateId: id, required: 0 }]);
  const toggleRequired = (id: number) =>
    setPicked(state.map((s) => (s.templateId === id ? { ...s, required: s.required ? 0 : 1 } : s)));
  /** 已失效的绑定（模板被删/归档）—— 它们不在候选里，要单独列出来让人看见 */
  const missing = bound.filter((b) => b.missing);
  const brokenCount = candidates.filter((c) => !c.bindable).length;
  /**
   * 「显示全部模板」开关：默认只列**能绑的**（好模板）+ 已绑的，
   * 打开后把坏模板也列出来（置灰）—— 让人知道"这份模板存在，只是不能绑"，
   * 而不是以为它消失了。
   */
  const shown = showAll ? candidates : candidates.filter((c) => c.bindable);
  const close = () => { if (picked === null || JSON.stringify(picked) === JSON.stringify(bound.map(b=>({templateId:b.templateId,required:b.required}))) || window.confirm('有未保存的模板修改，确定放弃并关闭吗？')) onClose(); };

  return (
    <Modal
      open
      title={`${position.name} —— 本阶段用哪几份模板出文书`}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button
            kind="primary"
            disabled={busy || !q.data}
            onClick={() =>
              run(async () => {
                /**
                 * 整表替换：提交的就是最终状态。失效的引用（模板被删除/归档）
                 * 如果在列表里，就**必须**先清掉再保存 —— 因为它们不在候选里，
                 * 服务端会以"模板已归档/不存在"拒绝，提交上去只会换回一句报错。
                 * 所以上面拦一次、让用户先明确处理，而不是让保存神秘失败。
                 */
                if (missing.length) {
                  toast(`有 ${missing.length} 条引用已失效（模板被删除或归档），请先点「清掉失效引用」再保存`, 'err');
                  return;
                }
                const items = state.map((s, i) => ({ templateId: s.templateId, required: s.required, seq: (i + 1) * 10 }));
                const r = await api.put<{ items: PositionDocBinding[] }>(`/api/position-templates/${position.id}/templates`, { items });
                const n = r.items?.length ?? items.length;
                const req = (r.items ?? []).filter((x) => x.required).length;
                toast(
                  n === 0
                    ? `已清空「${position.name}」的文书模板绑定：出文书时回到该类型的全部模板`
                    : `已保存：本阶段应出 ${n} 份文书${req ? `，其中必须出具 ${req} 份` : ''}`,
                  'ok',
                );
                onSaved();
              })
            }
          >
            保存绑定
          </Button>
        </>
      }
    >
      <div className="notice notice-info">
        优先级是<strong>阶段绑定 &gt; 工作台绑定 &gt; 工作类型全部</strong>：这里绑过之后，
        这份工作里出文书<strong>默认只列这里选的模板</strong>，不会和同类型下别的阶段的文书混在一起。
        一份都不选 = 回到「该类型的全部模板」（与以前一样）。
      </div>

      {q.loading && <Loading text="读取可选模板…" />}
      {q.error && (
        <div className="small" style={{ color: 'var(--err)' }}>
          读不到可选模板：{q.error.message}
        </div>
      )}

      {q.data && (
        <>
          {missing.length > 0 && (
            <div className="notice" style={{ borderColor: 'var(--err)' }}>
              <strong>有 {missing.length} 条引用的模板已经不可用了：</strong>
              <div className="col" style={{ gap: 4, marginTop: 6 }}>
                {missing.map((m) => (
                  <div key={m.templateId} className="small">
                    {m.name} —— {m.missingReason ?? '引用的模板已删除，请重新选择'}
                  </div>
                ))}
              </div>
              <div className="row mt8">
                <Button
                  size="sm"
                  kind="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const keep = bound.filter((b) => !b.missing).map((b) => ({ templateId: b.templateId, required: b.required, seq: b.seq }));
                      await api.put(`/api/position-templates/${position.id}/templates`, { items: keep });
                      toast(`已清掉 ${missing.length} 条失效引用`, 'ok');
                      setPicked(null);
                      q.reload();
                    })
                  }
                >
                  清掉失效引用
                </Button>
              </div>
            </div>
          )}

          <div className="row mb8">
            <strong className="small">可选模板（{shown.filter((c) => c.bindable || isPicked(c.id)).length} 份可绑）</strong>
            <div className="spacer" />
            {brokenCount > 0 && (
              <label className="small muted" style={{ cursor: 'pointer' }}>
                <input className="check-box" type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 显示打不开的模板（{brokenCount}）
              </label>
            )}
          </div>

          {shown.length === 0 ? (
            <Empty text="这个工作类型下还没有模板。先到「模板库」上传，再回来绑定。" />
          ) : (
            <div className="col" style={{ gap: 6 }}>
              {shown.map((c) => {
                const on = isPicked(c.id);
                const req = state.find((s) => s.templateId === c.id)?.required === 1;
                return (
                  <div
                    key={c.id}
                    className="row small"
                    style={{ gap: 6, alignItems: 'flex-start', opacity: c.bindable ? 1 : 0.55 }}
                  >
                    <input
                      className="check-box"
                      type="checkbox"
                      checked={on}
                      disabled={!c.bindable}
                      onChange={() => toggle(c.id)}
                    />
                    <span
                      style={{ flex: 1, cursor: c.bindable ? 'pointer' : 'not-allowed' }}
                      onClick={() => c.bindable && toggle(c.id)}
                    >
                      <strong>{c.name}</strong>
                      <span className="muted"> （{c.file_format}{c.code ? ` · ${c.code}` : ''}）</span>
                      {c.health_ok === 0 ? (
                        <Tag kind="err">打不开</Tag>
                      ) : c.health_ok === 1 ? (
                        <Tag kind="ok">可用</Tag>
                      ) : (
                        <Tag>未校验</Tag>
                      )}
                      {!c.bindable && (
                        <div className="check-detail" style={{ color: 'var(--err)' }}>
                          不能绑定：{c.unbindableReason}
                        </div>
                      )}
                    </span>
                    {on && (
                      <label className="small nowrap" style={{ cursor: 'pointer' }} title="标了「必须出具」的，工作台里没出会提示「缺文书」">
                        <input className="check-box" type="checkbox" checked={req} onChange={() => toggleRequired(c.id)} /> 必须出具
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="small muted mt8">
            已选 {state.length} 份{state.some((s) => s.required) ? `，其中必须出具 ${state.filter((s) => s.required).length} 份` : ''}。
            保存时会校验：打不开的模板、已归档的模板、别的工作类型的模板都不能绑（服务端也会拦）。
          </div>
        </>
      )}
    </Modal>
  );
}

function PositionModal({
  position,
  workTypeId,
  onClose,
  onSaved,
}: {
  position?: PositionRule;
  workTypeId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    code: position?.code ?? '',
    name: position?.name ?? '',
    seq: String(position?.seq ?? 1),
    folderName: position?.folder_name ?? '',
    durationHint: position?.duration_hint ?? '',
    description: position?.description ?? '',
  });
  /** 目录名：false = 从已有目录里选，true = 新建一个（§10.1 的 ① 与 ②） */
  const [creatingDir, setCreatingDir] = useState(false);
  /** 按期次分目录（契约 §5 / §12.3）：NULL = 不启用 */
  const [periodOn, setPeriodOn] = useState(Boolean((position?.period_dir ?? '').trim()));
  const [periodFmt, setPeriodFmt] = useState((position?.period_dir ?? '').trim() || DEFAULT_PERIOD_FORMAT);
  const close = useUnsavedClose({form,periodOn,periodFmt},onClose);
  const { busy, run } = useAction();

  /**
   * 可选目录从哪来：取该工作类型下**任意一个已绑定资料目录的工作台**的绑定根。
   * 契约 §10 的要求是「从已有目录里选，绝不猜」——选项清单必须来自真实磁盘。
   *
   * 一个已绑定的工作台都没有时（还没绑 / 接口失败）**不报错**，退回手填目录名，
   * 并在提示里说清"请先在工作台里绑定资料目录"。
   */
  const wbs = useApi<{ items: Workbench[] }>(`/api/workbenches?workTypeId=${workTypeId}&limit=100`, [workTypeId]);
  const boundWb = (wbs.data?.items ?? []).find((w) => (w.external_root ?? '').trim());
  const rootPath = (boundWb?.external_root ?? '').trim() || null;
  const subdirs = useApi<{ items: FolderSubdir[] }>(
    rootPath ? `/api/folders/subdirs?path=${encodeURIComponent(rootPath)}` : null,
    [rootPath],
  );
  const dirs = subdirs.data?.items ?? [];
  const listFailed = Boolean(rootPath) && Boolean(subdirs.error);
  const canList = Boolean(rootPath) && !listFailed;

  /**
   * 新建目录的建议名（§12.1）：`N.名称`，`N` 取同级已有编号的最大值 + 1。
   * 只认「数字 + 分隔符（`. - _`，§12.1 的定稿是半角点，旧写法也认，免得撞号）」开头的目录；
   * `2025年`、`1月`、`照片` 这类没编号的目录不参与（§12.2）。
   */
  const suggestDirName = (): string => {
    let max = 0;
    for (const d of dirs) {
      const m = /^(\d+)\s*[.\-_]/.exec((d.name ?? '').trim());
      if (m) max = Math.max(max, Number(m[1]));
    }
    const label = (form.name || position?.name || '新阶段')
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '');
    return `${max + 1}.${label}`;
  };

  const folderProblem = creatingDir && canList ? folderNameProblem(form.folderName) : null;
  const periodProblem = periodOn ? periodFormatProblem(periodFmt) : null;

  const save = () =>
    run(async () => {
      if (folderProblem) {
        toast(folderProblem, 'err');
        return;
      }
      if (periodProblem) {
        toast(periodProblem, 'err');
        return;
      }
      const payload = {
        ...form,
        code: position?.code??form.code,
        seq: Number(form.seq) || 1,
        workTypeId,
        /**
         * periodDir 显式传：开启 → 格式串（空则用 A 型默认）；关闭 → null
         * （后端 'periodDir' in b 才动它，null/'' = 不按期次分目录）。
         */
        periodDir: periodOn ? periodFmt.trim() || DEFAULT_PERIOD_FORMAT : null,
      };
      if (position) await api.put(`/api/position-templates/${position.id}`, payload);
      else await api.post('/api/position-templates', payload);
      onSaved();
    });

  return (
    <Modal
      open
      title={position ? `编辑阶段：${position.name}` : '新增阶段'}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button kind="primary" disabled={busy || !form.code || !form.name || Boolean(folderProblem) || Boolean(periodProblem)} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="inline-fields">
        <Field label="阶段编码" required hint="例如 P07">
          <Input value={form.code} disabled={!!position} onChange={(v) => setForm({ ...form, code: v })} />
        </Field>
        <Field label="序号" hint="决定执行顺序">
          <Input value={form.seq} onChange={(v) => setForm({ ...form, seq: v })} type="number" />
        </Field>
      </div>
      <Field label="阶段名称" required>
        <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="例如：到货与开箱" />
      </Field>

      {/* 目录名：从已有目录里选（§10.1 ①）或显式新建（§10.1 ②） */}
      <Field
        label="目录名"
        hint={
          canList ? (
            <>
              从已有目录里选，避免文件落到新建的空目录里。可选项来自「{boundWb?.name}」绑定的资料目录{' '}
              <span className="mono">{rootPath}</span>。
            </>
          ) : listFailed ? (
            <>列不了这个资料目录下的子目录：{subdirs.error?.message ?? '未知错误'}。可以先手填目录名，或到工作台里检查它。</>
          ) : (
            '请先在工作台里绑定资料目录，之后这里会列出可选目录；现在可以先手填目录名。'
          )
        }
      >
        {canList && subdirs.loading ? (
          <Loading text="读取可选目录…" />
        ) : canList ? (
          <>
            <Select
              value={creatingDir ? NEW_DIR : form.folderName}
              onChange={(v) => {
                if (v === NEW_DIR) {
                  setCreatingDir(true);
                  setForm((f) => ({ ...f, folderName: f.folderName.trim() || suggestDirName() }));
                  return;
                }
                setCreatingDir(false);
                setForm((f) => ({ ...f, folderName: v }));
              }}
              placeholder="不设置（按「序号_阶段名」建在资料目录下）"
              options={[
                ...(form.folderName && !creatingDir && !dirs.some((d) => d.name === form.folderName)
                  ? [{ value: form.folderName, label: `${form.folderName}（当前设置，不在这个目录里）` }]
                  : []),
                ...dirs.map((d) => ({
                  value: d.name,
                  label: `${d.name}（${d.fileCount}${d.countCapped ? '+' : ''} 个文件）`,
                })),
                { value: NEW_DIR, label: '＋ 新建目录…' },
              ]}
            />
            {creatingDir && (
              <div className="mt8">
                <Input
                  value={form.folderName}
                  onChange={(v) => setForm((f) => ({ ...f, folderName: v }))}
                  placeholder={suggestDirName()}
                />
                <div className="small muted mt4">
                  这个目录还不存在，平台会在第一次落盘时创建它。名字填错不会报错，只会多出一个空目录、文件落到别处
                  —— 能选已有目录时优先选。
                </div>
              </div>
            )}
            {folderProblem && (
              <div className="small mt4" style={{ color: 'var(--err)' }}>
                {folderProblem}
              </div>
            )}
          </>
        ) : (
          <Input
            value={form.folderName}
            onChange={(v) => setForm({ ...form, folderName: v })}
            placeholder="留空用序号+名称"
          />
        )}
      </Field>

      {/* 按期次分目录（契约 §5：周期工作 + 配了格式才生效） */}
      <Field
        label="按期次分目录"
        hint={'开启后，这一阶段的文件落在「阶段目录\期次」里。可用占位符 {yyyy}（年）{yy}（两位年）{mm}（月，补零）{m}（月）{q}（季度）{d}（日）；\\ 表示下一层。'}
      >
        <span className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input
            className="check-box"
            type="checkbox"
            checked={periodOn}
            onChange={(e) => setPeriodOn(e.target.checked)}
          />
          <span className="small">按本期期次单独放一层（周期工作才生效）</span>
        </span>
        {periodOn && (
          <div className="mt8">
            <Input value={periodFmt} onChange={setPeriodFmt} placeholder={DEFAULT_PERIOD_FORMAT} />
            <div className="small muted mt4">
              {'例：{yyyy}\\{m}月 → 2026\\1月（月份不带前导零）；{yyyy}\\{mm}月 → 2026\\01月'}
              <br />
              默认 A 型：<span className="mono">{DEFAULT_PERIOD_FORMAT}</span>
            </div>
            {periodProblem && (
              <div className="small mt4" style={{ color: 'var(--err)' }}>
                {periodProblem}
              </div>
            )}
          </div>
        )}
      </Field>

      <Field label="建议工期">
        <Input value={form.durationHint} onChange={(v) => setForm({ ...form, durationHint: v })} placeholder="例如：1-3 个工作日" />
      </Field>
      <Field label="这一阶段要做什么">
        <Textarea value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={2} />
      </Field>
    </Modal>
  );
}

function RuleModal({
  kind,
  positionId,
  rule,
  onClose,
  onSaved,
}: {
  kind: 'material' | 'evidence';
  positionId: number;
  rule?: MaterialRule | EvidenceRule;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEvidence = kind === 'evidence';
  const [form, setForm] = useState<Record<string, string>>(
    isEvidence
      ? {
          title: (rule as EvidenceRule)?.title ?? '',
          minCount: String((rule as EvidenceRule)?.min_count ?? 1),
          shootingPoints: (rule as EvidenceRule)?.shooting_points ?? '',
          angles: (rule as EvidenceRule)?.angles ?? '',
          hint: (rule as EvidenceRule)?.hint ?? '',
          required: String((rule as EvidenceRule)?.required ?? 1),
        }
      : {
          name: (rule as MaterialRule)?.name ?? '',
          category: (rule as MaterialRule)?.category ?? 'material',
          retention: (rule as MaterialRule)?.retention ?? '',
          hint: (rule as MaterialRule)?.hint ?? '',
          required: String((rule as MaterialRule)?.required ?? 1),
        },
  );
  const { busy, run } = useAction();
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const close = useUnsavedClose(form,onClose);

  return (
    <Modal
      open
      title={isEvidence ? (rule ? '编辑影像要求' : '新增影像要求') : rule ? '编辑材料' : '新增材料'}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>取消</Button>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (isEvidence) {
                  await api.post('/api/evidences', {
                    id: (rule as EvidenceRule)?.id,
                    positionTemplateId: positionId,
                    title: form.title,
                    minCount: Number(form.minCount) || 1,
                    shootingPoints: form.shootingPoints,
                    angles: form.angles,
                    hint: form.hint,
                    required: Number(form.required),
                  });
                } else {
                  await api.post('/api/materials', {
                    id: (rule as MaterialRule)?.id,
                    positionTemplateId: positionId,
                    name: form.name,
                    category: form.category,
                    retention: form.retention,
                    hint: form.hint,
                    required: Number(form.required),
                  });
                }
                onSaved();
              })
            }
          >
            保存
          </Button>
        </>
      }
    >
      {isEvidence ? (
        <>
          <Field label="拍什么" required hint="例如：开箱前外包装 / 设备铭牌与序列号">
            <Input value={form.title} onChange={set('title')} />
          </Field>
          <div className="inline-fields">
            <Field label="最少张数">
              <Input value={form.minCount} onChange={set('minCount')} type="number" />
            </Field>
            <Field label="是否必需" hint="缺了会不会影响验收">
              <Select value={form.required} onChange={set('required')} options={[{ value: '1', label: '必需' }, { value: '0', label: '选备' }]} />
            </Field>
          </div>
          <Field label="拍摄要点" hint="必须看清什么，例如「运单号、外观无破损」">
            <Textarea value={form.shootingPoints} onChange={set('shootingPoints')} rows={2} />
          </Field>
          <Field label="建议角度">
            <Input value={form.angles} onChange={set('angles')} placeholder="例如：正面全景 + 特写" />
          </Field>
          <Field label="补充说明">
            <Input value={form.hint} onChange={set('hint')} />
          </Field>
        </>
      ) : (
        <>
          <Field label="材料名称" required hint="例如：到货通知/送货单">
            <Input value={form.name} onChange={set('name')} />
          </Field>
          <div className="inline-fields">
            <Field label="类别">
              <Select
                value={form.category}
                onChange={set('category')}
                options={[
                  { value: 'doc', label: '文档' },
                  { value: 'material', label: '材料' },
                  { value: 'form', label: '表单' },
                  { value: 'record', label: '记录' },
                ]}
              />
            </Field>
            <Field label="是否必需">
              <Select value={form.required} onChange={set('required')} options={[{ value: '1', label: '必需' }, { value: '0', label: '选备' }]} />
            </Field>
          </div>
          <Field label="留存要求" hint="例如：长期归档 / 随卷归档">
            <Input value={form.retention} onChange={set('retention')} />
          </Field>
          <Field label="提示说明">
            <Input value={form.hint} onChange={set('hint')} />
          </Field>
        </>
      )}
    </Modal>
  );
}
