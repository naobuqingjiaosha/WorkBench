import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { all, run } from '../db/index.ts';
import { finalizeTimesheet, createTimesheetRun, exportTimesheet, getTimesheetRun, storeTimesheetSource, editableTimesheetInput } from '../domain/timesheets.ts';
import { ApiError, body, fail, intParam, ok, qInt } from './reply.ts';
import { readParts, cleanupTemp } from './upload.ts';
import {getTemplate,templateAbsPath,getWorkType} from '../domain/service.ts';
import {inspectTimesheetSource,timesheetPreferences,saveTimesheetPreferences,suggestTimesheetEdit,applyTimesheetEdit} from '../domain/timesheet-workspace.ts';
const column = z.number().int().min(1).max(400);
const mapping = z.object({ sheet: z.string().min(1), startRow: z.number().int().min(1).max(10000), personColumn: column, dateColumn: column.optional(), hoursColumn: column.optional(), projectColumn: column.optional(), statusColumn: column.optional(), dateHeaderRow: z.number().int().min(1).max(100).optional(), dateStartColumn: column.optional() });
const projectReport=z.object({id:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/),month:z.string(),sourceName:z.string().optional(),monthConfirmed:z.literal(true),mergeConfirmed:z.boolean(),choices:z.array(z.object({key:z.string().max(500),name:z.string().min(1).max(300),target:z.string().trim().min(1).max(300),alias:z.boolean()})).min(1).max(500)});
const inputSchema = z.object({ workbenchId:z.number().int().positive().optional(), periodId:z.number().int().positive().optional(), month: z.string(), templateId: z.string().uuid(), rdId: z.string().uuid(), attendanceId: z.string().uuid(), rdMapping: mapping, attendanceMapping: mapping, projects: z.array(z.string().trim().min(1).max(300)).min(1).max(500), assignments: z.record(z.string(), z.union([z.string().trim().min(1),z.array(z.string().trim().min(1)).max(500)])), requiredPeople:z.array(z.string().trim().min(1)).min(1).max(1000).optional(), rdComplete: z.boolean(), aliases: z.record(z.string(), z.string().trim().min(1)).optional(), exclusions: z.record(z.string(), z.string().trim().min(1).max(1000)).optional(), overrides: z.array(z.object({ person: z.string().min(1), date: z.string(), status: z.enum(['work', 'project', 'leave', 'rest', 'excluded']), project: z.string().optional(), hours: z.number().min(0).max(8).optional(), source: z.string().trim().min(1).max(1000) })).max(10000).optional() });
export function registerTimesheetRoutes(app: FastifyInstance): void {
    app.get('/api/timesheets/preferences/:id',async(req,reply)=>{try{return ok(reply,timesheetPreferences(intParam(req,'id')));}catch(e){return fail(reply,e);}});
    app.put('/api/timesheets/preferences/:id',async(req,reply)=>{try{return ok(reply,saveTimesheetPreferences(intParam(req,'id'),Number(body(req).revision),body(req).value));}catch(e){return fail(reply,e);}});
    app.post('/api/timesheets/inspect',async(req,reply)=>{try{const b=body(req);if(!['template','rd','attendance','project-report'].includes(String(b.kind)))throw new ApiError('BAD_KIND','输入类别无效');const manual=b.mapping===undefined?undefined:mapping.safeParse(b.mapping);if(manual&&!manual.success)throw new ApiError('BAD_MAPPING','考勤映射格式无效');if(manual&&b.kind!=='attendance')throw new ApiError('BAD_MAPPING','手动识别仅适用于考勤资料');return ok(reply,await inspectTimesheetSource(String(b.id),String(b.month),b.kind as 'template'|'rd'|'attendance'|'project-report',manual?.data));}catch(e){return fail(reply,e);}});
    app.post('/api/timesheets/:id/suggest',async(req,reply)=>{try{return ok(reply,await suggestTimesheetEdit(intParam(req,'id'),String(body(req).instruction??'')));}catch(e){return fail(reply,e);}});
    app.post('/api/timesheets/:id/edit',async(req,reply)=>{try{return ok(reply,await applyTimesheetEdit(intParam(req,'id'),body(req)));}catch(e){return fail(reply,e);}});
    app.post('/api/timesheets/library/:id',async(req,reply)=>{try{
        const t=getTemplate(intParam(req,'id'));
        if(!t||t.archived_at||t.file_format!=='xlsx'||!t.work_type_id||getWorkType(t.work_type_id)?.code!=='department-hours')throw new ApiError('BAD_TEMPLATE','请选择部门工时专用Excel模板');
        return ok(reply,await storeTimesheetSource(t.name+'.xlsx',readFileSync(templateAbsPath(t))),201);
    }catch(e){return fail(reply,e);}});
    app.post('/api/timesheets/sources', async (req, reply) => { let files: {
        tempPath: string;
    }[] = []; try {
        const upload = await readParts(req);
        files = upload.files;
        if (upload.files.length !== 1)
            throw new ApiError('ONE_FILE', '每次请选择一个 XLSX 文件');
        const f = upload.files[0]!;
        return ok(reply, await storeTimesheetSource(f.fileName, readFileSync(f.tempPath)), 201);
    }
    catch (e) {
        return fail(reply, e);
    }
    finally {
        for (const f of files)
            cleanupTemp(f.tempPath);
    } });
    app.get('/api/timesheets', async (req, reply) => {try{const wid=qInt(req,'workbenchId'),pid=qInt(req,'periodId');const where:string[]=[];const args:number[]=[];if(wid){where.push('workbench_id=?');args.push(wid);}if(pid){where.push('period_id=?');args.push(pid);}return ok(reply, { items: all('SELECT id,month,status,rule_version,created_at,workbench_id,period_id,artifact_id FROM timesheet_run'+(where.length?' WHERE '+where.join(' AND '):'')+' ORDER BY id DESC LIMIT 100',args) });}catch(e){return fail(reply,e);}});
    app.post('/api/timesheets', async (req, reply) => { try {
        if(!Array.isArray(body(req).requiredPeople)||!(body(req).requiredPeople as unknown[]).length)throw new ApiError('ROSTER_REQUIRED','请先核对并填写本月明确参与名单，来源候选不会自动纳入');
        const parsed = inputSchema.extend({projectReport:projectReport.optional(),projectReportHistory:z.array(projectReport).max(10).optional(),projectAliases:z.record(z.string().min(2),z.string()).optional(),attendanceSources:z.array(z.object({id:z.string().uuid(),mapping})).max(10).optional(),payroll:z.object({workdays:z.array(z.number().int().min(1).max(31)),fullPay:z.boolean(),deductions:z.record(z.string(),z.number().min(0).max(8))}).optional(),allocations:z.array(z.object({person:z.string(),date:z.string(),shares:z.record(z.string(),z.number().min(0).max(8)),reason:z.string().min(1)})).optional()}).safeParse(body(req));
        if (!parsed.success)
            throw new ApiError('BAD_INPUT', '工时输入或映射不完整', 400, parsed.error.issues);
        return ok(reply, await createTimesheetRun(parsed.data), 201);
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.get('/api/timesheets/:id', async (req, reply) => { try {
        const record = getTimesheetRun(intParam(req, 'id'));
        if ((req.query as { view?: string }).view === 'edit')
            return ok(reply, { ...record, input: editableTimesheetInput(record) });
        return ok(reply, record);
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.get('/api/timesheets/:id/export', async (req, reply) => { try {
        const id = intParam(req, 'id'), record = getTimesheetRun(id), bytes = await exportTimesheet(id);
        return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`部门工时-${record.month}-${record.status === 'final' ? '定稿' : '草稿'}-${id}.xlsx`)}`).send(bytes);
    }
    catch (e) {
        return fail(reply, e);
    } });
    app.post('/api/timesheets/:id/finalize', async (req, reply) => { try {
        return ok(reply, await finalizeTimesheet(intParam(req,'id'),body(req).reviewed===true));
    }
    catch (e) {
        return fail(reply, e);
    } });
}
