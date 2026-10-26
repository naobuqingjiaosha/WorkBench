import { collectWorkContext } from '../domain/work-context.ts';
import { dossierReadiness } from '../domain/dossier.ts';
import { recalcProgress } from '../domain/service.ts';
import { reviewMemoryFacts } from '../domain/memory-facts.ts';
import { refreshPositionDocRequirements } from '../domain/service.ts';
import type { FastifyInstance } from 'fastify';
import { all, get, run, tx } from '../db/index.ts';
import { ApiError, body, fail, intParam, ok, requireStr } from './reply.ts';
import { closePeriodSeries, event, listPeriods, requirePeriod, requireWorkbench, savePeriodRule, syncPeriods, updatePeriod, validDate, periodTemplates,relatedPeriods,periodReadiness } from '../domain/periods.ts';
import {saveInspection,inspectionDocuments,isMonthlyInspection} from '../domain/inspections.ts';
import { listWorkflowInbox, projectReadiness, reviewProjectMaterial } from '../domain/workflow.ts';
import {registerInspectionDraftRoutes} from './routes-inspection-drafts.ts';
export function registerWorkflowRoutes(app: FastifyInstance): void {
    registerInspectionDraftRoutes(app);
    app.get('/api/periods/:id/inspections',async(req,reply)=>{try{const p=requirePeriod(intParam(req,'id'));if(!isMonthlyInspection(p))throw new ApiError('BAD_INSPECTION','当前工作不办理月度检查');return ok(reply,inspectionDocuments(p));}catch(e){return fail(reply,e);}});
    app.post('/api/periods/:id/inspections',async(req,reply)=>{try{return ok(reply,saveInspection(intParam(req,'id'),body(req)),201);}catch(e){return fail(reply,e);}});
    app.put('/api/periods/:id/inspections/:inspectionId',async(req,reply)=>{try{return ok(reply,saveInspection(intParam(req,'id'),body(req),intParam(req,'inspectionId')));}catch(e){return fail(reply,e);}});
    app.get('/api/periods/:id/related',async(req,reply)=>{try{return ok(reply,{items:relatedPeriods(intParam(req,'id'))});}catch(e){return fail(reply,e);}});
    app.post('/api/periods/:id/materials',async(req,reply)=>{try{
      const id=intParam(req,'id'),p=requirePeriod(id),w=requireWorkbench(p.workbench_id),b=body(req),title=requireStr(b,'title');
      if((p.status==='done'&&!isMonthlyInspection(p))||w.archived_at)throw new ApiError('PERIOD_DONE','请先重新打开期次或恢复归档');
      if(title.length>300)throw new ApiError('BAD_TITLE','材料标题过长');
      const kind=String(b.requirementKind??'external');if(!['external','reference','generated'].includes(kind))throw new ApiError('BAD_MATERIAL','材料用途无效');
      const r=tx(()=>{const r=run('INSERT INTO period_material(period_id,title,required,requirement_kind) VALUES(?,?,?,?)',[id,title,b.required===false?0:1,kind]);event(id,'material-added',title);return r;});
      recalcProgress(w.id);return ok(reply,{id:r.lastInsertRowid},201);
    }catch(e){return fail(reply,e);}});
    app.post('/api/workbenches/:id/close-series',async(req,reply)=>{try{return ok(reply,closePeriodSeries(intParam(req,'id')));}catch(e){return fail(reply,e);}});
    app.get('/api/workbenches/:id/context',async(req,reply)=>{try{const pid=(req.query as {periodId?:string}).periodId;return ok(reply,await collectWorkContext(intParam(req,'id'),pid?Number(pid):null));}catch(e){return fail(reply,e);}});
    app.post('/api/positions/:id/doc-requirements', async (req, reply) => {try {const b=body(req); if(b.apply===true && b.expected===undefined) throw new ApiError('PREVIEW_REQUIRED','请先预览要求差异'); return ok(reply,refreshPositionDocRequirements(intParam(req,'id'),b.apply===true ? b.expected : undefined));} catch(e){return fail(reply,e);} });
    app.post('/api/generate/facts', async (req,reply)=>{try{const b=body(req);const wid=b.workbenchId ? Number(b.workbenchId):null,pid=b.periodId ? Number(b.periodId):null;if(wid)requireWorkbench(wid);if(pid)requirePeriod(pid,wid);if(!b.values || typeof b.values!=='object' || Array.isArray(b.values))throw new ApiError('BAD_VALUES','需要字段值');return ok(reply,reviewMemoryFacts(wid,pid,b.values as Record<string,unknown>));}catch(e){return fail(reply,e);}});
    app.get('/api/workflow/inbox', async (_req, reply) => ok(reply, listWorkflowInbox()));
    app.get('/api/workbenches/:id/readiness', async (req, reply) => { try {
        return ok(reply, projectReadiness(intParam(req, 'id')));
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/checklist/:id/review', async (req, reply) => { try {
        reviewProjectMaterial(intParam(req, 'id'), body(req));
        return ok(reply, { reviewed: true });
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/agent/memories/:id', async (req, reply) => {
        try {
            const id = intParam(req, 'id'), b = body(req), m = get<{
                workbench_id: number | null;
                period_id: number | null;
                valid_from: string | null;
                valid_until: string | null;
            }>('SELECT * FROM agent_memory WHERE id=?', [id]);
            if (!m)
                throw new ApiError('NOT_FOUND', '记忆不存在', 404);
            if (get('SELECT id FROM agent_memory WHERE supersedes_id=?', [id])) throw new ApiError('MEMORY_HISTORY', '历史记忆不可修改，请更正当前版本');
            const wid = b.workbench_id === undefined ? m.workbench_id : b.workbench_id === null ? null : Number(b.workbench_id);
            const pid = b.period_id === undefined ? m.period_id : b.period_id === null ? null : Number(b.period_id);
            if (wid)
                requireWorkbench(wid);
            if (pid) {
                if (!wid)
                    throw new ApiError('WORK_REQUIRED', '期次记忆需要所属工作');
                requirePeriod(pid, wid);
            }
            const from = b.valid_from === undefined ? m.valid_from : b.valid_from ? validDate(b.valid_from) : null, until = b.valid_until === undefined ? m.valid_until : b.valid_until ? validDate(b.valid_until) : null;
            if (from && until && from > until)
                throw new ApiError('BAD_DATE', '生效时间不能晚于失效时间');
            if (b.status !== undefined && !['active', 'archived'].includes(String(b.status)))
                throw new ApiError('BAD_STATUS', '记忆状态无效');
            const factKey=b.fact_key === undefined ? undefined : b.fact_key === null ? null : requireStr(b,'fact_key');
            const factValue=b.fact_value === undefined ? undefined : b.fact_value === null ? null : requireStr(b,'fact_value');
            if ((factKey == null)!==(factValue == null)) throw new ApiError('BAD_FACT','事实字段和事实值须同时填写或清空');
            tx(() => {
            const previous = run(`INSERT INTO agent_memory(text,tags,source,workbench_id,due_date,status,created_at,valid_from,valid_until,period_id,confirmed,supersedes_id,fact_key,fact_value) SELECT text,tags,source,workbench_id,due_date,'archived',created_at,valid_from,valid_until,period_id,confirmed,supersedes_id,fact_key,fact_value FROM agent_memory WHERE id=?`, [id]).lastInsertRowid;
            run('UPDATE agent_memory SET supersedes_id=? WHERE id=?', [previous, id]);
            run('UPDATE agent_memory SET text=COALESCE(?,text),source=COALESCE(?,source),workbench_id=?,period_id=?,valid_from=?,valid_until=?,confirmed=1,status=COALESCE(?,status) WHERE id=?', [b.text === undefined ? null : requireStr(b, 'text'), b.source === undefined ? null : requireStr(b, 'source'), wid, pid, from, until, b.status === undefined ? null : String(b.status), id]);
            if (factKey !== undefined) run('UPDATE agent_memory SET fact_key=?,fact_value=? WHERE id=?',[factKey,factValue!,id]);
            });
            return ok(reply, { updated: true });
        }
        catch (e) {
            return fail(reply, e);
        }
    });
    app.get('/api/agent/memories/:id/history', async (req, reply) => { try { const items: unknown[] = []; let id = intParam(req, 'id'); const seen = new Set<number>(); while (id && !seen.has(id)) { seen.add(id); const m = get<{supersedes_id:number|null}>('SELECT * FROM agent_memory WHERE id=?',[id]); if (!m) break; items.push(m); id = m.supersedes_id ?? 0; } return ok(reply,{items}); } catch(e) {return fail(reply,e);} });
    app.get('/api/workbenches/:id/periods', async (req, reply) => { try {
        const id = intParam(req, 'id');
        requireWorkbench(id);
        return ok(reply, { items: listPeriods(id), rule: get('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]) ?? null });
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/workbenches/:id/periods/rule', async (req, reply) => { try {
        return ok(reply, savePeriodRule(intParam(req, 'id'), body(req)));
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.post('/api/workbenches/:id/periods/sync', async (req, reply) => { try {
        return ok(reply, { items: syncPeriods(intParam(req, 'id')) });
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.post('/api/periods/sync', async (_req, reply) => { try {
        for (const w of all<{
            workbench_id: number;
        }>("SELECT r.workbench_id FROM work_period_rule r JOIN workbench w ON w.id=r.workbench_id WHERE w.deleted_at IS NULL AND w.status='active'"))
            syncPeriods(w.workbench_id);
        return ok(reply, { synced: true });
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.get('/api/periods/:id', async (req, reply) => { try {
        const id = intParam(req, 'id');
        return ok(reply, { ...requirePeriod(id), readiness:periodReadiness(id),materials: all('SELECT * FROM period_material WHERE period_id=?', [id]), files: all('SELECT id,file_name,is_final,template_id,kind,file_role FROM artifact WHERE work_period_id=? AND deleted_at IS NULL', [id]) });
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/periods/:id', async (req, reply) => { try {
        return ok(reply, updatePeriod(intParam(req, 'id'), body(req)));
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.post('/api/periods/:id/templates', async (req, reply) => { try {
        const id = intParam(req, 'id'), p = requirePeriod(id), snapshot = JSON.parse(p.snapshot), templates = periodTemplates(p.workbench_id), b = body(req);
        let selected = templates;
        if (b.templateIds !== undefined) {
            if (!Array.isArray(b.templateIds) || b.templateIds.some(x => !Number.isSafeInteger(x))) throw new ApiError('BAD_TEMPLATES','请选择有效模板');
            // Selection is local to this period. The type pool includes templates
            // added after the period was created, but never another business type.
            const { listTemplates, getWorkbench,templateGenerationScope } = await import('../domain/service.ts');
            const pool = listTemplates({workTypeId:getWorkbench(p.workbench_id)!.work_type_id});
            if (b.templateIds.some(id => !pool.some(t=>t.id===id))) throw new ApiError('WRONG_TEMPLATE','模板不属于当前工作类型');
            const required = Array.isArray(b.requiredIds) ? b.requiredIds : [];
            if (required.some(id => !(b.templateIds as unknown[]).includes(id))) throw new ApiError('BAD_TEMPLATES','必备成果须在所选模板中');
            const {templateFingerprint} = await import('../domain/periods.ts');
            const resultMaterials=b.resultMaterials??{};
            if(!resultMaterials||typeof resultMaterials!=='object'||Array.isArray(resultMaterials))throw new ApiError('BAD_MAPPING','成果对应材料配置无效');
            const mapping=resultMaterials as Record<string,unknown>;
            for(const [tid,mid] of Object.entries(mapping))if(!(b.templateIds as number[]).includes(Number(tid))||(mid!==null&&(!Number.isSafeInteger(mid)||!get("SELECT id FROM period_material WHERE id=? AND period_id=? AND requirement_kind='generated'",[Number(mid),id]))))throw new ApiError('BAD_MAPPING','成果只能对应本期的材料要求');
            selected = pool.filter(t=>(b.templateIds as unknown[]).includes(t.id)).map(t=>({id:t.id,name:t.name,required:required.includes(t.id),file_rel:t.file_rel,digest:templateFingerprint(t),generation_scope:templateGenerationScope(t),materialId:mapping[String(t.id)]??null}));
        }
        const difference = { before: snapshot.templates, after: selected };
        if (b.apply === true) {
            if (p.status === 'done' && !isMonthlyInspection(p))
                throw new ApiError('PERIOD_DONE', '请先重新打开期次');
            if (JSON.stringify(b.expected) !== JSON.stringify(difference))
                throw new ApiError('STALE', '模板配置已经变化，请重新预览', 409);
            tx(() => { run('UPDATE work_period SET snapshot=? WHERE id=?', [JSON.stringify({ ...snapshot, templates:selected }), id]); event(id, 'template-change', JSON.stringify(difference)); });
        }
        return ok(reply, difference);
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/periods/:id/materials/:materialId', async (req, reply) => {
        try {
            const id = intParam(req, 'id'), p = requirePeriod(id), mid = intParam(req, 'materialId'), b = body(req), status = requireStr(b, 'status'), note = String(b.note ?? ''), aid = b.artifact_id == null ? null : Number(b.artifact_id);
            if(requireWorkbench(p.workbench_id).archived_at)throw new ApiError('ARCHIVED','请先恢复归档工作');
            if (p.status === 'done' && !isMonthlyInspection(p))
                throw new ApiError('PERIOD_DONE', '请先重新打开期次');
            if (!get('SELECT id FROM period_material WHERE id=? AND period_id=?', [mid, id]))
                throw new ApiError('NOT_FOUND', '材料要求不存在', 404);
            if (!['missing', 'provided', 'verified', 'na'].includes(status))
                throw new ApiError('BAD_STATUS', '材料状态无效');
            if (status === 'na' && !note.trim())
                throw new ApiError('REASON_REQUIRED', '不适用必须填写原因');
            if (['provided', 'verified'].includes(status) && !aid)
                throw new ApiError('FILE_REQUIRED', '请关联本期材料文件');
            if(aid&&get<{kind:string}>('SELECT kind FROM artifact WHERE id=?',[aid])?.kind==='generated'&&get<{requirement_kind:string}>('SELECT requirement_kind FROM period_material WHERE id=?',[mid])?.requirement_kind==='external')throw new ApiError('EXTERNAL_REQUIRED','生成文书不能替代外部签章件或证明');
            if (aid && !get('SELECT id FROM artifact WHERE id=? AND workbench_id=? AND (work_period_id IS NULL OR work_period_id=?) AND deleted_at IS NULL', [aid, p.workbench_id, id]))
                throw new ApiError('WRONG_FILE', '文件不属于本工作或已属于另一期');
            tx(() => { if (aid)
                run('UPDATE artifact SET work_period_id=? WHERE id=?', [id, aid]); run('UPDATE period_material SET status=?,note=?,artifact_id=? WHERE id=?', [status, note, aid, mid]); event(id, 'material', JSON.stringify({ id: mid, status, note, artifact_id: aid })); });
            recalcProgress(p.workbench_id);
            return ok(reply, { updated: true });
        }
        catch (e) {
            return fail(reply, e);
        }
    });
    app.get('/api/workbenches/:id/dossier',async(req,reply)=>{try{return ok(reply,dossierReadiness(intParam(req,'id')));}catch(e){return fail(reply,e);}});
    app.put('/api/checklist/:id/requirement',async(req,reply)=>{try{
      const id=intParam(req,'id'),b=body(req);
      const c=get<{workbench_id:number}>('SELECT p.workbench_id FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE c.id=? AND p.deleted_at IS NULL',[id]);
      if(!c)throw new ApiError('NOT_FOUND','材料项不存在',404);requireWorkbench(c.workbench_id);
      if(typeof b.required!=='boolean'||!String(b.reason??'').trim())throw new ApiError('REASON_REQUIRED','调整适用要求需要填写依据');
      tx(()=>{run('UPDATE checklist_item SET required=?,review_note=? WHERE id=?',[b.required?1:0,String(b.reason),id]);run('INSERT INTO workflow_event(action,detail) VALUES(?,?)',['requirement',JSON.stringify({workbenchId:c.workbench_id,itemId:id,required:b.required,reason:b.reason})]);});
      recalcProgress(c.workbench_id);return ok(reply,{updated:true});
    }catch(e){return fail(reply,e);}});
    app.get('/api/quick-todos', async (req, reply) => {try{const wid=Number((req.query as {workbenchId?:string}).workbenchId);if(wid)requireWorkbench(wid);return ok(reply, { items: wid?all('SELECT * FROM quick_todo WHERE workbench_id=? ORDER BY status,due_date,id DESC',[wid]):all('SELECT * FROM quick_todo ORDER BY status,due_date,id DESC') });}catch(e){return fail(reply,e);}});
    app.post('/api/quick-todos', async (req, reply) => { try {
        const b = body(req), title = requireStr(b, 'title');
        if (title.length > 300)
            throw new ApiError('BAD_TITLE', '标题过长');
        if (b.workbench_id)
            requireWorkbench(Number(b.workbench_id));
        const kind=String(b.kind??'task');if(!['task','delivery','coordination'].includes(kind))throw new ApiError('BAD_KIND','待办类型无效');
        if(kind==='delivery' && (!b.workbench_id || get<{domain:string}>('SELECT t.domain FROM workbench w JOIN work_type t ON t.id=w.work_type_id WHERE w.id=?',[Number(b.workbench_id)])?.domain!=='project'))throw new ApiError('BAD_KIND','供应商交付事项仅适用于项目实施');
        if(b.position_id && !get('SELECT id FROM position_instance WHERE id=? AND workbench_id=? AND deleted_at IS NULL',[Number(b.position_id),Number(b.workbench_id)]))throw new ApiError('BAD_STAGE','阶段不属于当前工作');
        const r = run('INSERT INTO quick_todo(title,due_date,note,workbench_id,kind,position_id,owner) VALUES(?,?,?,?,?,?,?)', [title, b.due_date ? validDate(b.due_date) : null, String(b.note ?? ''), b.workbench_id ? Number(b.workbench_id) : null,kind,b.position_id?Number(b.position_id):null,String(b.owner??'')]);
        if(b.workbench_id)recalcProgress(Number(b.workbench_id));
        return ok(reply, { id: r.lastInsertRowid }, 201);
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.put('/api/quick-todos/:id', async (req, reply) => { try {
        const b = body(req),id=intParam(req,'id');
        const todo=get<{title:string;note:string;owner:string;due_date:string|null;status:string;workbench_id:number|null}>('SELECT * FROM quick_todo WHERE id=?',[id]);
        if(!todo)throw new ApiError('NOT_FOUND','待办不存在',404);
        if(todo.workbench_id&&requireWorkbench(todo.workbench_id).archived_at)throw new ApiError('ARCHIVED','请先恢复归档工作');
        if (b.status!==undefined&&!['open', 'done'].includes(String(b.status)))
            throw new ApiError('BAD_STATUS', '状态无效');
        const title=b.title===undefined?todo.title:requireStr(b,'title'),note=b.note===undefined?todo.note:String(b.note??''),owner=b.owner===undefined?todo.owner:String(b.owner);
        if(title.length>300||note.length>10000||owner.length>300)throw new ApiError('BAD_CONTENT','事项、进度说明或责任方过长');
        const due=b.due_date===undefined?todo.due_date:b.due_date?validDate(b.due_date):null;
        tx(()=>{run('UPDATE quick_todo SET status=?,title=?,note=?,owner=?,due_date=? WHERE id=?',[String(b.status??todo.status),title,note,owner,due,id]);run('INSERT INTO workflow_event(action,detail) VALUES(?,?)',['todo-update',JSON.stringify({id,workbenchId:todo.workbench_id,before:todo,after:{title,note,owner,due_date:due,status:b.status??todo.status}})]);});
        if(todo.workbench_id)recalcProgress(todo.workbench_id);
        return ok(reply, { updated: true });
    }
    catch (e) {
        return fail(reply, e);
    } });
}
