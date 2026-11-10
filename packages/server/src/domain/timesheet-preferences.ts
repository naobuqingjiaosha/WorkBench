import {get,run} from '../db/index.ts';
import {ApiError} from '../api/reply.ts';
import {requireWorkbench} from './periods.ts';

export function timesheetPreferences(id:number) {
    const work = requireWorkbench(id);
    if (get<{executor:string}>('SELECT executor FROM work_type WHERE id=?',[work.work_type_id])?.executor !== 'timesheet' || work.archived_at)
        throw new ApiError('BAD_SCOPE','请选择可编辑的部门工时工作');
    const row = get<{revision:number;value:string}>('SELECT revision,value FROM timesheet_preferences WHERE workbench_id=?',[id]);
    return row ? {revision:row.revision,value:JSON.parse(row.value)} : {revision:0,value:{people:[],assignments:{},fullPay:true}};
}

export function saveTimesheetPreferences(id:number,revision:number,value:unknown) {
    if (timesheetPreferences(id).revision !== revision) throw new ApiError('STALE','人员规则已更新，请刷新',409);
    const serialized = JSON.stringify(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || serialized.length > 100000)
        throw new ApiError('BAD_RULE','人员参考数据格式无效或过大');
    run(`INSERT INTO timesheet_preferences(workbench_id,value,revision) VALUES(?,?,1)
         ON CONFLICT(workbench_id) DO UPDATE SET value=excluded.value,revision=timesheet_preferences.revision+1`,[id,serialized]);
    return timesheetPreferences(id);
}
