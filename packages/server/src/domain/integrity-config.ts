/** Eight types confirmed against the source task document and by the user. */
export const INTEGRITY_TYPES = [
 {code:'integrity-talk',name:'谈心谈话及台账',frequency:null,requirements:['谈心谈话记录','谈话台账'],steps:['按项目安排谈心谈话','收集并核对独立谈话记录','更新谈话台账并归档']},
 {code:'integrity-annual-plan',name:'年度监督检查工作计划',frequency:'yearly',requirements:[],steps:['编制年度监督检查工作计划','核对计划内容并定稿']},
 {code:'integrity-monthly-inspection',name:'月度监督检查',frequency:'monthly',requirements:['监督检查记录','监督情况报送表册'],steps:['安排本月检查','逐次检查并整理记录','核对多份报送表册','保存生成文件']},
 {code:'integrity-system-check',name:'季度八大体系自查表',frequency:'quarterly',requirements:['八大体系自查表','核对与归档材料'],steps:['按季度填报','逐项核对自查表','保存归档材料']},
 {code:'integrity-risk',name:'季度廉政风险研判',frequency:'quarterly',requirements:['风险研判会议纪要','风险研判材料'],steps:['安排研判日期','整理独立会议纪要及材料','核对归档']},
 {code:'integrity-study',name:'季度廉洁学习',frequency:'quarterly',requirements:['廉洁学习记录','廉洁学习材料'],steps:['安排学习日期','整理独立学习记录及材料','核对归档']},
 {code:'integrity-project-review',name:'季度项目研判考评会',frequency:'quarterly',requirements:['项目研判考评会议纪要','项目研判考评材料'],steps:['安排会议日期','整理独立会议纪要及材料','核对归档']},
 {code:'integrity-quarter-summary',name:'季度本领域监督工作推进情况汇报',frequency:'quarterly',requirements:['人工核对与定稿材料'],steps:['选择本季度相关工作及期次','主动生成 Word 初稿','核对事实来源并修改定稿','保存生成文件']},
] as const;
