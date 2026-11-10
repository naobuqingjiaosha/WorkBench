export type AttendanceMapping={sheet:string;startRow:number;personColumn:number;dateHeaderRow?:number;dateStartColumn?:number;dateColumn?:number;hoursColumn?:number;statusColumn?:number;projectColumn?:number};
export type PendingAttendance={replaceMain?:boolean;id:string;name:string;month:string;mapping:AttendanceMapping;error?:string;validation?:{key:string;people:string[]}};
type Scope={workbenchId?:number;periodId?:number;month?:string};
export function matchesTimesheetScope(input:Scope,scope:Scope):boolean {
 return input.workbenchId===scope.workbenchId&&input.periodId===scope.periodId&&(!scope.month||input.month===scope.month);
}
export function attendanceValidationKey(p:PendingAttendance):string {return JSON.stringify([p.id,p.month,p.mapping]);}
export function attendanceReady(p:PendingAttendance,month:string):boolean {return p.month===month&&p.validation?.key===attendanceValidationKey(p);}
export function adoptAttendance<T extends {month:string;attendanceId:string;attendanceMapping:AttendanceMapping;attendanceSources:{id:string;mapping:AttendanceMapping}[];pendingAttendance?:PendingAttendance}>(input:T):T {
 const p=input.pendingAttendance;
 if(!p||!attendanceReady(p,input.month))throw Error('请先验证当前考勤映射，再明确采用');
 if(input.attendanceId===p.id||input.attendanceSources.some(s=>s.id===p.id))throw Error('该考勤已采用，请勿重复添加');
 if(input.attendanceId&&!p.replaceMain&&input.attendanceSources.length>=10)throw Error('补充考勤最多10份，请先核对并移除不再使用的输入');
 const {pendingAttendance:_,...rest}=input;
 return {...rest,...input.attendanceId&&!p.replaceMain?{attendanceSources:[...input.attendanceSources,{id:p.id,mapping:p.mapping}]}:{attendanceId:p.id,attendanceMapping:p.mapping}} as T;
}
