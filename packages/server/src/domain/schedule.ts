/**
 * 周期性工作的排期计算
 *
 * 「清廉工程按月填」「工时表按月报」这类工作不需要阶段序列，
 * 它要的是**到时间提醒我**。这里负责算：下一次该什么时候做、还剩几天、是不是该提醒了。
 *
 * 设计取舍：
 *   · 日期算成「当月的第几号」，而不是存一个绝对日期 —— 因为每月/每季度都要重新算。
 *   · 日号限制在 1–28，避开 29/30/31 在部分月份不存在的问题（否则 31 号的工作
 *     在 2 月永远不触发）。用户要月末效果就填 28。
 *   · 提醒提前量默认 3 天，可调。
 *   · 全部是纯函数，不查库，方便单测。
 */

export type Recurrence = 'once' | 'monthly' | 'quarterly' | 'yearly';

export interface ScheduleSpec {
  recurrence: Recurrence;
  /** 每月/每季度的日号 1–28 */
  recur_day?: number | null;
  /** yearly 的月份 1–12 */
  recur_month?: number | null;
  /** 提前几天提醒 */
  remind_days?: number | null;
  /** 上次完成时间（ISO 或 YYYY-MM-DD） */
  last_done_at?: string | null;
  schedule_due_date?: string | null;
  last_done_period?: string | null;
}

export interface ScheduleState {
  /** 是否周期性工作 */
  recurring: boolean;
  /** 下一次该做的日期（YYYY-MM-DD）；once 时为空 */
  nextDue: string | null;
  /** 距离下次还有几天（负数=已逾期） */
  daysUntil: number | null;
  /** 现在是否该提醒（进入提前量窗口，或已逾期） */
  shouldRemind: boolean;
  /** 逾期天数，0 表示没逾期 */
  overdueDays: number;
  /** 本期内是否已经做过（按 last_done_at 判断） */
  doneThisPeriod: boolean;
  /**
   * 完成记录是否已经**覆盖今天所在这一期**（最近完成的那一期 ≥ 今天这一期）。
   *
   * 和 doneThisPeriod 只差"完成记录超前"这一种情形：
   *   doneThisPeriod              最近完成的那一期 **正好是** 今天这一期
   *   doneThroughCurrentPeriod    最近完成的那一期 **不早于** 今天这一期
   * 什么时候会超前：周期性工作的到期日一旦被推到下一期（新建时纠正首次到期日、
   * 或旧版本连点两下把未来的期记成完成），那时再点「完成本期」记的就是更靠后的期。
   * doneThisPeriod 对这种状态恒为 false，光看它拦不住"再吃掉一期"，所以判断能否
   * 再完成一次要用这个字段。once 恒为 false。
   */
  doneThroughCurrentPeriod: boolean;
  /** 给人看的排期说明，如「每月 5 号」 */
  label: string;
}

const RECUR_LABEL: Record<Recurrence, string> = {
  once: '单次工作',
  monthly: '每月',
  quarterly: '每季度',
  yearly: '每年',
};

export function recurrenceLabel(spec: ScheduleSpec): string {
  const day = clampDay(spec.recur_day);
  switch (spec.recurrence) {
    case 'monthly':
      return `每月 ${day} 号`;
    case 'quarterly':
      return `每季度首月 ${day} 号`;
    case 'yearly':
      return `每年 ${spec.recur_month ?? 1} 月 ${day} 号`;
    default:
      return RECUR_LABEL.once;
  }
}

/** 日号限制在 1–28：29/30/31 在部分月份不存在，会导致那些月永远不触发 */
export function clampDay(d: number | null | undefined): number {
  const n = Number(d);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(28, Math.floor(n));
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function diffDays(a: Date, b: Date): number {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / MS);
}

/**
 * 算出某个周期锚点的到期日。
 * @param from 从这个时间点起算（通常是「今天」或「上次完成时间」）
 *
 * 返回值保证**不早于** from（当天的锚点日算"没过去"），所以它也是"下一个未过的锚点日"。
 * createWorkbench 用它定新建周期工作的首次到期日，避免一建出来就是逾期的。
 */
export function nextOccurrenceOnOrAfter(spec: ScheduleSpec, from: Date): Date {
  const day = clampDay(spec.recur_day);
  const y = from.getFullYear();
  const m = from.getMonth();

  if (spec.recurrence === 'monthly') {
    const thisMonth = new Date(y, m, day);
    if (diffDays(thisMonth, from) >= 0) return thisMonth;
    return new Date(y, m + 1, day);
  }

  if (spec.recurrence === 'quarterly') {
    // 季度首月：1 / 4 / 7 / 10 月
    const qStartMonths = [0, 3, 6, 9];
    for (let i = 0; i < 8; i += 1) {
      const totalMonth = m + i;
      const yy = y + Math.floor(totalMonth / 12);
      const mm = ((totalMonth % 12) + 12) % 12;
      if (!qStartMonths.includes(mm)) continue;
      const cand = new Date(yy, mm, day);
      if (diffDays(cand, from) >= 0) return cand;
    }
    return new Date(y + 1, 0, day);
  }

  if (spec.recurrence === 'yearly') {
    const mon = Math.min(12, Math.max(1, Number(spec.recur_month) || 1)) - 1;
    const thisYear = new Date(y, mon, day);
    if (diffDays(thisYear, from) >= 0) return thisYear;
    return new Date(y + 1, mon, day);
  }

  return startOfDay(from);
}

export function computeSchedule(spec: ScheduleSpec, now: Date = new Date()): ScheduleState {
  const recurring = spec.recurrence !== 'once';
  const label = recurrenceLabel(spec);
  if (!recurring) {
    return {
      recurring: false, nextDue: null, daysUntil: null,
      shouldRemind: false, overdueDays: 0, doneThisPeriod: false, doneThroughCurrentPeriod: false, label,
    };
  }

  const remind = Math.max(0, Number(spec.remind_days ?? 3));
  const today = startOfDay(now);
  const lastDone = spec.last_done_at ? startOfDay(new Date(spec.last_done_at)) : null;

  const periodMonth = spec.recurrence === 'quarterly' ? Math.floor(today.getMonth()/3)*3 : spec.recurrence === 'yearly' ? Math.min(12,Math.max(1,Number(spec.recur_month)||1))-1 : today.getMonth();
  const currentDue = new Date(today.getFullYear(),periodMonth,clampDay(spec.recur_day));
  let due = spec.schedule_due_date ? startOfDay(new Date(spec.schedule_due_date+'T00:00:00')) : currentDue;
  if(Number.isNaN(due.getTime())) due=currentDue;
  const completed=spec.last_done_period ? new Date(spec.last_done_period+'T00:00:00') : lastDone ? periodCovering(spec,lastDone) : null;
  // 一旦有持久化到期日，只有明确完成才能推进；过了日期不自动丢弃欠办周期。
  if(!spec.schedule_due_date && completed && diffDays(completed,due)>=0) due=nextOccurrenceOnOrAfter(spec,new Date(completed.getFullYear(),completed.getMonth(),completed.getDate()+1));
  const daysUntil=diffDays(due,today);
  const overdueDays=Math.max(0,-daysUntil);
  const doneThisPeriod=Boolean(completed && diffDays(completed,currentDue)===0);
  // 「≥」而不是「===」：完成记录超前于今天这一期时，今天这一期同样不该再记一次完成
  const doneThroughCurrentPeriod=Boolean(completed && diffDays(completed,currentDue)>=0);
  return {
    recurring: true,
    nextDue: ymd(due),
    daysUntil,
    shouldRemind: daysUntil <= remind,
    overdueDays,
    doneThisPeriod,
    doneThroughCurrentPeriod,
    label,
  };
}

/**
 * 不晚于 from 的最近一个到期日（含当天）。
 * 例（每月 10 号）：from=9月18日 → 9月10日；from=9月5日 → 8月10日；from=9月10日 → 9月10日。
 *
 * 判据是 `diffDays(from, cand) >= 0`（from 不早于 cand）。写成 `diffDays(cand, from) >= 0`
 * 会把未来的到期日也返回，违背「不晚于」的语义 —— 这个函数被用来判断「完成时间之前那一期」，
 * 返回未来日期会让判断反向。
 *
 * new Date(y, m - 1, day) 的月份会自动归一化（m-1 = -1 表示上一年 12 月），不用手写跨年。
 * 传进来的日期都经过 startOfDay 归一，所以比较不受时分秒影响。
 */
export function previousOccurrenceOnOrBefore(spec: ScheduleSpec, from: Date): Date | null {
  const day = clampDay(spec.recur_day);
  const y = from.getFullYear();
  const m = from.getMonth();

  if (spec.recurrence === 'monthly') {
    const thisMonth = new Date(y, m, day);
    if (diffDays(from, thisMonth) >= 0) return thisMonth;
    return new Date(y, m - 1, day);
  }

  if (spec.recurrence === 'quarterly') {
    const qStartMonths = [0, 3, 6, 9];
    for (let i = 0; i < 8; i += 1) {
      const totalMonth = m - i;
      const yy = y + Math.floor(totalMonth / 12);
      const mm = ((totalMonth % 12) + 12) % 12;
      if (!qStartMonths.includes(mm)) continue;
      const cand = new Date(yy, mm, day);
      if (diffDays(from, cand) >= 0) return cand;
    }
    return null;
  }

  if (spec.recurrence === 'yearly') {
    const mon = Math.min(12, Math.max(1, Number(spec.recur_month) || 1)) - 1;
    const thisYear = new Date(y, mon, day);
    if (diffDays(from, thisYear) >= 0) return thisYear;
    return new Date(y - 1, mon, day);
  }

  return null;
}

/**
 * 某个时间点属于哪一期的窗口 —— 即不晚于它的最近一个到期日。
 *
 * 注意别和「下一个到期日」搞混：判断「这次完成算做完了哪一期」要往回找，
 * 不是往前找。例（每月 10 号）：
 *   完成于 9/12 → 属于 9/10 那一期（9 月这期做完了）
 *   完成于 10/5 → 属于 9/10 那一期（补做的还是 9 月那期）
 *   完成于 10/15 → 属于 10/10 那一期
 */
function periodCovering(spec: ScheduleSpec, at: Date): Date | null {
  return previousOccurrenceOnOrBefore(spec, at);
}

/** 排期状态 → 给界面用的严重程度 */
export function scheduleLevel(s: ScheduleState): 'ok' | 'soon' | 'due' | 'overdue' {
  if (!s.recurring) return 'ok';
  if (s.overdueDays > 0) return 'overdue';
  if (s.daysUntil === 0) return 'due';
  return s.shouldRemind ? 'soon' : 'ok';
}

/** 一句话描述当前状态，如「还有 2 天」「已逾期 3 天」 */
export function scheduleText(s: ScheduleState): string {
  if (!s.recurring || s.daysUntil === null) return '';
  if (s.overdueDays > 0) return `已逾期 ${s.overdueDays} 天`;
  if (s.daysUntil === 0) return '今天到期';
  return `还有 ${s.daysUntil} 天`;
}
