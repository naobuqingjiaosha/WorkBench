/**
 * 预置数据：工作类型、流程阶段、材料清单、影像清单
 *
 * 这些都是"起点"，不是"定论"——界面上随时可以增删改。
 * 行政管理的阶段由每项事务的流程决定，项目管理按标准实施流程走。
 */
import { get } from '../db/index.ts';
import { INTEGRITY_TYPES } from './integrity-config.ts';
import { listDeletedWorkTypeCodes } from '../core/config.ts';
import { upsertEvidence, upsertMaterial, upsertPosition, upsertWorkType } from './service.ts';

export function seedWorkTypesAndPositions(): { workTypes: number; positions: number; materials: number; evidences: number } {
  const stats = { workTypes: 0, positions: 0, materials: 0, evidences: 0 };
  const deleted = new Set(listDeletedWorkTypeCodes());

  for (const wt of WORK_TYPES) {
    // 用户明确删掉过的预置类型不再种回来，否则「删除」这个操作永远无效
    if (deleted.has(wt.code)) continue;
    const existed = get<{ id: number; archived_at: string | null }>(
      'SELECT id, archived_at FROM work_type WHERE code = ?',
      [wt.code],
    );
    // 已归档的预置类型同样跳过
    if (existed) continue; // 首次创建之外不覆盖用户设置或重新添加已删除的阶段。
    const workTypeId = upsertWorkType({
      ...wt,
      domain: wt.category,
      category: wt.group ?? (wt.category === 'project' ? wt.name : '部门综合管理'),
      mode: wt.mode ?? 'process',
    });
    if (!workTypeId) continue;
    if (!existed) stats.workTypes += 1;

    // 已经配过阶段的类型不重复灌，避免覆盖用户改过的内容
    const hasPositions = get<{ n: number }>('SELECT COUNT(*) AS n FROM position_template WHERE work_type_id = ?', [workTypeId])?.n ?? 0;
    if (hasPositions > 0) continue;

    for (const p of (wt.mode==='document'?[]:wt.positions)) {
      const existing = get<{ folder_name: string | null }>(
        'SELECT folder_name FROM position_template WHERE work_type_id = ? AND code = ?',
        [workTypeId, p.code],
      );
      const posId = upsertPosition({
        work_type_id: workTypeId,
        code: p.code,
        name: p.name,
        seq: p.seq,
        // 只在首次创建时写目录名，避免每次启动覆盖用户改过的值
        folder_name: existing?.folder_name ?? `${String(p.seq).padStart(2, '0')}_${p.name}`,
        description: p.description,
        duration_hint: p.duration,
        sort_order: p.seq * 10,
      });
      stats.positions += 1;
      p.materials?.forEach((m, i) => {
        upsertMaterial({
          position_template_id: posId,
          name: m.name,
          category: m.category ?? 'material',
          required: m.required ?? 1,
          retention: m.retention,
          hint: m.hint,
          sort_order: (i + 1) * 10,
        });
        stats.materials += 1;
      });
      p.evidences?.forEach((e, i) => {
        upsertEvidence({
          position_template_id: posId,
          title: e.title,
          min_count: e.min ?? 1,
          max_count: e.max,
          shooting_points: e.points,
          angles: e.angles,
          required: e.required ?? 1,
          hint: e.hint,
          sort_order: (i + 1) * 10,
        });
        stats.evidences += 1;
      });
    }
  }
  return stats;
}

/* ------------------------------- 数据定义 ------------------------------- */

interface SeedEvidence {
  title: string;
  min?: number;
  max?: number;
  points?: string;
  angles?: string;
  required?: number;
  hint?: string;
}
interface SeedMaterial {
  name: string;
  category?: 'doc' | 'material' | 'form' | 'record';
  required?: number;
  retention?: string;
  hint?: string;
}
interface SeedPosition {
  code: string;
  name: string;
  seq: number;
  description?: string;
  duration?: string;
  materials?: SeedMaterial[];
  evidences?: SeedEvidence[];
}
interface SeedWorkType {
  group?:string;
  executor?:'general'|'timesheet';
  period_defaults?:string;
  code: string;
  name: string;
  category: 'admin' | 'project';
  description: string;
  icon?: string;
  color?: string;
  sort_order: number;
  /**
   * 驱动方式，默认 process（流程驱动）。
   * 行政管理工作是 document（文书驱动）—— 没有阶段序列，按模板直接出文书。
   */
  mode?: 'process' | 'document';
  positions: SeedPosition[];
}

const WORK_TYPES: SeedWorkType[] = [
  ...INTEGRITY_TYPES.map((t,i)=>({code:t.code,name:t.name,group:'清廉工程',category:'admin' as const,description:'按已明确的业务配置；默认排期为起始建议，须按实际通知调整。材料和步骤可维护，完成状态须据实确认。',sort_order:30+i,mode:t.frequency?'document' as const:'process' as const,period_defaults:t.frequency?JSON.stringify({frequency:t.frequency,due_month_offset:t.frequency==='quarterly'?2:0,due_day:31,remind_days:3,requirements:t.requirements,steps:t.steps}):undefined,positions:t.frequency?[]:[{code:'collect',name:'材料收集与核对归档',seq:1,description:t.steps.join(' → '),materials:t.requirements.map(name=>({name,required:1}))}]})),
  {code:'integrity-temporary',name:'清廉工程通用临时事项',group:'清廉工程',category:'admin',description:'无固定周期；按实际事项新建，独立材料、文书与完成状态。',sort_order:39,mode:'document',positions:[]},
  ...([
    {code:'safety-report',name:'安全月度工作',group:'安全管理',frequency:'monthly'},
    {code:'integrity-report',name:'清廉季度工作',group:'清廉工程',frequency:'quarterly'},
    {code:'department-year',name:'部门年度总结',group:'部门综合管理',frequency:'yearly'},
    {code:'department-hours',name:'部门工时',group:'部门综合管理',frequency:'monthly',executor:'timesheet'},
    {code:'temporary-task',name:'临时工作',group:'临时工作',frequency:null},
  ] as const).map((t,i)=>({code:t.code,name:t.name,group:t.group,category:'admin' as const,description:'可调整的起始配置；请按实际业务绑定模板和材料要求。',sort_order:i+1,mode:'document' as const,executor:('executor' in t?t.executor:'general') as 'general'|'timesheet',period_defaults:t.frequency?JSON.stringify({frequency:t.frequency,due_month_offset:0,due_day:31,remind_days:3,requirements:[]}):undefined,positions:[]})),
  ...([
    {code:'software-project',name:'软件研发项目',stages:['需求与计划','设计与研发','测试与交付','验收与归档'],materials:['需求及实施计划','设计与研发交付清单','测试报告及交付记录','验收与档案移交材料']},
    {code:'integration-project',name:'系统集成项目',stages:['方案与计划','采购与供应商交付','部署与联调','验收与归档'],materials:['实施方案及计划','供应商到货交付及核验记录','部署联调与测试记录','验收与档案移交材料']},
  ]).map((t,i)=>({code:t.code,name:t.name,group:i?'系统集成':'软件研发',category:'project' as const,description:'可调整的办理清单；按本项目合同核对适用材料，历史项目只补录资料无需重走流程。',sort_order:20+i,mode:'process' as const,positions:t.stages.map((name,j)=>({code:'S'+(j+1),name,seq:j+1,materials:[{name:t.materials[j]!,required:1}]}))})),
  {
    code: 'admin',
    name: '行政管理',
    category: 'admin',
    description: '按周期重复的填表与报表工作：清廉工程月度/季度表单、工时表等。没有阶段序列，到时间照着模板填一份即可。',
    icon: 'folder',
    color: '#2563eb',
    sort_order: 10,
    mode: 'document',
    positions: [
      {
        code: 'A01',
        name: '接收与登记',
        seq: 1,
        description: '接收上级来文、通知、任务，登记编号并明确办理时限。',
        duration: '当日',
        materials: [
          { name: '来文原件/电子件', category: 'material', retention: '随卷归档' },
          { name: '收文登记记录', category: 'record', hint: '登记：来文单位、文号、标题、收到日期、办理时限' },
          { name: '办理意见（领导批示）', category: 'record', required: 0 },
        ],
      },
      {
        code: 'A02',
        name: '起草',
        seq: 2,
        description: '按事项选用对应模板起草文书，明确事项、依据、措施、时限。',
        duration: '1-2 个工作日',
        materials: [
          { name: '起草稿', category: 'doc', required: 1, hint: '用模板生成，保留过程版本' },
          { name: '政策/制度依据', category: 'material', required: 0, hint: '引用上级文件要写明文号' },
        ],
      },
      {
        code: 'A03',
        name: '审核与签发',
        seq: 3,
        description: '科室负责人审核内容与格式，分管领导签发。',
        duration: '1-2 个工作日',
        materials: [
          { name: '审核意见记录', category: 'record', required: 0 },
          { name: '签发件（正式稿）', category: 'doc', required: 1 },
        ],
      },
      {
        code: 'A04',
        name: '印发与送达',
        seq: 4,
        description: '编号、盖章、印发，并登记送达对象与时间。',
        duration: '1 个工作日',
        materials: [
          { name: '正式印发件（盖章扫描件）', category: 'doc', required: 1 },
          { name: '发文登记台账', category: 'record', required: 1 },
          { name: '送达/签收记录', category: 'record', required: 0 },
        ],
      },
      {
        code: 'A05',
        name: '归档与台账',
        seq: 5,
        description: '原件与电子件同步归档，更新工作台账，方便年度汇总和迎检。',
        duration: '事项办结后 5 个工作日内',
        materials: [
          { name: '归档电子件（PDF）', category: 'doc', required: 1, retention: '长期' },
          { name: '工作台账更新记录', category: 'record', required: 1 },
        ],
      },
    ],
  },
  {
    code: 'project',
    name: '项目实施',
    category: 'project',
    description: '从立项到验收归档的完整实施流程。每一步规定该准备什么材料、该留存什么证据（含开箱、到货等关键影像）。',
    icon: 'cube',
    color: '#0d9488',
    sort_order: 20,
    positions: [
      {
        code: 'P01',
        name: '立项与准备',
        seq: 1,
        description: '明确范围、签订合同、组建实施小组、确定联络机制与实施计划。',
        duration: '5-10 个工作日',
        materials: [
          { name: '项目立项批复/委托书', category: 'doc', required: 1 },
          { name: '合同及附件', category: 'doc', required: 1, retention: '长期' },
          { name: '实施方案（含进度计划）', category: 'doc', required: 1 },
          { name: '项目组织架构与联系人清单', category: 'record', required: 1 },
          { name: '项目启动会纪要', category: 'record', required: 0 },
        ],
        evidences: [
          {
            title: '合同/协议签署页',
            min: 1,
            points: '双方签字页、盖章清晰可辨，日期可见',
            angles: '正面垂直拍摄，避免反光',
            hint: '涉及金额页建议一并拍摄',
          },
          {
            title: '项目启动会现场',
            min: 2,
            points: '参会人员、会议横幅/投影标题、签到表',
            angles: '会场全景 + 签到表特写',
          },
        ],
      },
      {
        code: 'P02',
        name: '到货与开箱',
        seq: 2,
        description: '设备/材料到场后的清点与验收。这是最容易出纠纷的环节，影像证据必须完整。',
        duration: '到货后 1-3 个工作日',
        materials: [
          { name: '到货通知/送货单', category: 'material', required: 1 },
          { name: '装箱单与随机资料', category: 'material', required: 1 },
          { name: '开箱验收记录表', category: 'form', required: 1 },
          { name: '设备序列号清单', category: 'record', required: 1, hint: '逐台登记：名称、型号、序列号、数量' },
          { name: '到货异常/缺损记录', category: 'record', required: 0, hint: '有异常必填，并同步书面通知供应商' },
        ],
        evidences: [
          {
            title: '开箱前外包装',
            min: 2,
            points: '完整包装箱、运单号/唛头、外观无破损、数量标识',
            angles: '正面全景 + 运单号特写',
            hint: '外包装有破损必须先拍再拆',
          },
          {
            title: '开箱过程',
            min: 2,
            points: '封条完整、开箱动作、箱内填充与摆放',
            angles: '侧上方 45 度',
          },
          {
            title: '设备铭牌与序列号',
            min: 1,
            points: '型号、序列号、生产日期必须清晰可读',
            angles: '贴近特写，必要时补光',
            hint: '这是核对合同与保修的关键证据',
          },
          {
            title: '设备外观全景',
            min: 2,
            points: '整机外观、面板指示灯、接口、有无磕碰划痕',
            angles: '正面 + 侧面各一张',
          },
          {
            title: '随机附件与资料',
            min: 1,
            points: '电源线、说明书、保修卡、合格证、光盘/U盘',
            angles: '平铺俯拍',
          },
          {
            title: '数量清点现场',
            min: 1,
            points: '同型号设备并排摆放，可数清数量',
            angles: '俯拍全景',
            hint: '数量多的分批拍，每批标注序号',
          },
        ],
      },
      {
        code: 'P03',
        name: '安装与调试',
        seq: 3,
        description: '按方案安装部署、上电调试、参数配置，记录过程与关键参数。',
        duration: '视规模而定',
        materials: [
          { name: '施工/安装方案交底记录', category: 'record', required: 0 },
          { name: '安装调试记录表', category: 'form', required: 1, hint: '记录每台设备的安装位置、调试结果、参数' },
          { name: '设备/系统配置清单', category: 'record', required: 1 },
          { name: '上电测试记录', category: 'record', required: 1 },
          { name: '隐蔽工程/布线检查记录', category: 'record', required: 0 },
        ],
        evidences: [
          {
            title: '安装位置与固定',
            min: 2,
            points: '设备安装位置、机柜内布局、走线整齐、固定螺栓',
            angles: '正面 + 侧面',
          },
          {
            title: '加电启动与自检',
            min: 2,
            points: '指示灯状态、屏幕自检信息、参数界面',
            angles: '屏幕正面特写，避免反光',
          },
          {
            title: '线缆标签与配线',
            min: 2,
            points: '标签内容清晰、两端一致、理线规范',
            angles: '近距特写',
            hint: '验收常查项，务必留证据',
          },
          {
            title: '调试结果界面',
            min: 1,
            points: '调试成功提示、关键参数数值、版本号',
            angles: '屏幕截图或拍照，保证数值可读',
          },
        ],
      },
      {
        code: 'P04',
        name: '试运行与培训',
        seq: 4,
        description: '连续试运行观察稳定性，对使用人员进行培训并留下签到与考核记录。',
        duration: '试运行不少于 7 天',
        materials: [
          { name: '试运行记录（连续记录）', category: 'record', required: 1, hint: '每日记录运行状况、故障及处理' },
          { name: '培训方案与课件', category: 'doc', required: 1 },
          { name: '培训签到表', category: 'form', required: 1 },
          { name: '培训照片/视频', category: 'material', required: 1 },
          { name: '用户操作手册', category: 'doc', required: 1 },
        ],
        evidences: [
          { title: '培训现场', min: 2, points: '讲师、参训人员、投影内容、签到表', angles: '会场全景 + 签到表特写' },
          { title: '试运行监控画面', min: 2, points: '运行状态、连续运行时长、无告警', angles: '屏幕特写' },
        ],
      },
      {
        code: 'P05',
        name: '验收',
        seq: 5,
        description: '提交验收申请与全套资料，组织验收会，形成验收结论。资料不齐不要报验。',
        duration: '视评审安排',
        materials: [
          { name: '验收申请报告', category: 'doc', required: 1, hint: '用模板生成，写明完成情况与自检结论' },
          { name: '项目自检/自评报告', category: 'doc', required: 1 },
          { name: '竣工资料清单（对照合同逐项核对）', category: 'form', required: 1 },
          { name: '设备/材料合格证与检测报告', category: 'material', required: 1 },
          { name: '隐蔽工程与测试记录汇总', category: 'record', required: 0 },
          { name: '培训与试运行记录汇总', category: 'record', required: 1 },
          { name: '验收会议签到表', category: 'form', required: 1 },
          { name: '验收意见/验收报告（签字盖章）', category: 'doc', required: 1, retention: '长期' },
          { name: '遗留问题整改承诺', category: 'record', required: 0 },
        ],
        evidences: [
          {
            title: '验收会现场',
            min: 2,
            points: '验收组人员、会议标题、现场查验过程',
            angles: '会场全景 + 查验特写',
          },
          {
            title: '验收资料装订成册',
            min: 1,
            points: '目录页、页码、装订整齐，能看出册数与卷号',
            angles: '俯拍',
          },
          {
            title: '签字盖章页',
            min: 1,
            points: '验收组签字、单位盖章、日期清晰',
            angles: '正面垂直拍摄',
          },
        ],
      },
      {
        code: 'P06',
        name: '归档与移交',
        seq: 6,
        description: '整理全部过程资料与影像，编制移交清单，完成资产/资料移交。',
        duration: '验收通过后 10 个工作日内',
        materials: [
          { name: '项目档案目录（卷内目录）', category: 'form', required: 1 },
          { name: '资料移交清单（双方签字）', category: 'form', required: 1, retention: '长期' },
          { name: '影像资料汇总（按阶段整理）', category: 'material', required: 1 },
          { name: '质保与售后服务承诺', category: 'doc', required: 1 },
          { name: '项目总结报告', category: 'doc', required: 0 },
        ],
        evidences: [
          { title: '档案盒与卷内目录', min: 1, points: '档案盒脊背标签、卷内目录首页', angles: '正面拍摄' },
          { title: '移交现场', min: 1, points: '双方交接人、移交清单、签字', angles: '全景' },
        ],
      },
    ],
  },
];
