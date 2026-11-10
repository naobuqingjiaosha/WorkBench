/**
 * OCR 任务队列
 *
 * 为什么要有队列：OCR 是 CPU 密集且耗时的操作，不能让上传请求等着它。
 * 上传时只登记任务，后台串行处理，界面轮询进度。
 *
 * 状态流转：
 *   pending  已登记，等处理
 *   running  正在识别
 *   done     识别完成，文字已写进 artifact.ocr_text 并进入全文索引
 *   failed   识别失败，失败原因记在 ocr_error
 *   skipped  不适合 OCR（例如 PDF、或未启用 OCR）
 *
 * 登记任务有两条路，别混用：
 *   · {@link enqueueOcr}    上传/扫描未识别走它 —— 已经 `done` 的**不重跑**（安静跳过，这是对的）；
 *   · {@link requeueOcr}    界面「重新识别」走它 —— `done`/`failed`/`skipped` 都真的重排，
 *     并把"到底排没排上"返回给调用方（以前这条路是"回成功但实际没做"）。
 *
 * B4-11（看门狗 + 健康事件）：单条任务**被判为 failed 时**额外记一条 `ocrFailure` 健康事件
 * （见 {@link recordOcrFailure}），于是"一张坏图让 OCR 失败"这件事会留在 `/api/health` 的
 * `events` 与首页「运行状态」卡片里，而不是只闪一下控制台。`done` / `skipped` 一律不记。
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { all, get, run } from '../db/index.ts';
import { recordHealthEvent } from './health.ts';
import { artifactAbsPath, getArtifact, indexArtifact, looksLikeImage, type Artifact } from './store.ts';
import { isOcrCandidate, ocrEnabled, ocrFile, summarizeOcrError } from './ocr.ts';

export interface OcrItem {
  id: number;
  artifact_id: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  ocr_error: string | null;
  confidence: number | null;
  chars: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/**
 * 「明确重排」的结果。
 *
 * 存在的理由：`enqueueOcr` 是给**上传**用的（不打扰已经识别完的行），
 * 而「重新识别」是用户**明说**要重跑一次。两者必须分开 —— 混用一个函数就会出现
 * "接口回 `queued:true`、`enqueueOcr` 里却 `return` 掉、实际什么都没发生"（见 {@link requeueOcr}）。
 * 所以重排这条路把**到底做没做**返回出来，路由照着它回话，不再靠猜。
 */
export interface RequeueOutcome {
  /** 是否真的排上了队。false 只有一种情况：已经在排队/正在识别（重复点击不重复排队） */
  queued: boolean;
  /** 调用之后该行的状态 */
  status: OcrItem['status'];
  /** 重排之前的状态；没有任务记录时为 null */
  previousStatus: OcrItem['status'] | null;
  /** 重排之前已经累计的尝试次数（attempts 会被清零，原值在这里留个底，便于排查过重试几次） */
  previousAttempts: number;
}

export interface OcrQueueState {
  enabled: boolean;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  items: (OcrItem & { file_name: string; title: string; workbench_id: number | null })[];
  lastMessage: string;
}

let processing = false;
export function isOcrProcessing(): boolean { return processing; }
let lastMessage = '';

/* ------------------------------ 登记任务 ------------------------------ */

export function enqueueOcr(artifactId: number): void {
  const a = getArtifact(artifactId);
  if (!a) return;
  if (!isOcrCandidate(a.file_name)) {
    run('UPDATE artifact SET ocr_status = ? WHERE id = ?', ['skipped', artifactId]);
    return;
  }
  const existing = get<OcrItem>('SELECT * FROM ocr_item WHERE artifact_id = ?', [artifactId]);
  if (existing) {
    /**
     * 认成功（done）就到此为止：上传/扫描未识别都不该把已识别好的文件重新烧一遍 CPU。
     * 用户真要重跑走 {@link requeueOcr}（「重新识别」按钮），那条路会明确回话，不会再"报成功但没做"。
     */
    if (existing.status === 'done') return;
    // 已经在排队/正在识别：重复登记没有意义，保持原状即可（processQueue 会把它跑完）
    if (existing.status === 'pending' || existing.status === 'running') return;
    run(
      `UPDATE ocr_item SET status = 'pending', ocr_error = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [existing.id],
    );
  } else {
    run('INSERT INTO ocr_item (artifact_id, status) VALUES (?, ?)', [artifactId, 'pending']);
  }
  run('UPDATE artifact SET ocr_status = ? WHERE id = ?', ['pending', artifactId]);
}

/**
 * 「重新识别」：用户**明说**要把这一行的识别重跑一遍（界面上的按钮，或 `POST /api/ocr/artifacts/:id`）。
 *
 * 与 `enqueueOcr` 的区别就是这个函数存在的全部理由：`enqueueOcr` 对 `done` 直接 return
 * （上传时不该重跑），于是"重新识别"以前回 `{"queued":true}` 却**什么都没做**
 * —— 库里的 `attempts` 不动、任务也不会跑。这里把 `done` / `failed` / `skipped` 都置回 `pending`，
 * 让 {@link processQueue} 真的再跑一次。
 *
 * 三条口径（都是刻意的，别顺手改）：
 *
 * 1. **`attempts` 清零**。`processQueue` 领取时 `attempts = attempts + 1`，而
 *    `enqueueMissing` 与 `startup-repair` 都有 `attempts < 3` 的硬闸门（见那两处注释）。
 *    不清零的话，一个曾经失败过 3 次的文件即使重排也**永远不会被认领**（attempts 已是 3，
 *    再 +1 只会更高），用户点了"重新识别"依旧什么都不发生 —— 那就还是本次要修的那个缺陷。
 *    语义上也说得通：attempts 记的是"这一轮试了几次"；用户显式重跑就是开一轮新的预算。
 *    原值不丢，随 {@link RequeueOutcome.previousAttempts} 返回，排查时能看出之前重试过几次。
 * 2. **已有识别结果保留**（`artifact.ocr_text` 与 `ocr_item.chars/confidence` 一律不动）。
 *    重跑的意图是"再认一遍、可能认得更好"，不是"先清空"：万一下一次因为引擎抽风而失败，
 *    上次认出来的文字还在，检索也还搜得到，不会因为一次重跑把已有成果弄丢。
 *    `finish()` 本次只覆盖 `ocr_error`，识别成功后才写新的 `ocr_text`。
 * 3. **不动检索索引口径**。这里不碰 `kb_document` / `artifact_search`；索引照旧只在
 *    `finish()` / `indexArtifact()` 里按原有规则更新（重跑期间旧文字仍在索引里，属预期）。
 *
 * @returns 实际做没做。`queued:false` 只发生在"已经在排队/正在识别"（重复点击不重复排队）
 */
export function requeueOcr(artifactId: number): RequeueOutcome {
  const a = getArtifact(artifactId);
  // 调用方已经校验过 artifact 与"能不能 OCR"（见路由），走不到这里；真到了就当没排上，别假装成功
  if (!a || !isOcrCandidate(a.file_name)) return { queued: false, status: 'skipped', previousStatus: null, previousAttempts: 0 };

  const existing = get<OcrItem>('SELECT * FROM ocr_item WHERE artifact_id = ?', [artifactId]);
  const previousStatus = existing?.status ?? null;
  const previousAttempts = existing?.attempts ?? 0;
  // 已经在排队/正在识别：不重复排队（队列本来就是串行的，重复登记只会白跑）。
  // 但这次**要如实回报**，不能像以前那样回一个 queued:true 让界面以为换了新任务。
  if (existing && (existing.status === 'pending' || existing.status === 'running')) {
    return { queued: false, status: existing.status, previousStatus, previousAttempts };
  }

  if (existing) {
    run(
      `UPDATE ocr_item SET status = 'pending', ocr_error = NULL, attempts = 0,
         started_at = NULL, finished_at = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [existing.id],
    );
  } else {
    // 以前没有任务记录（例如上传时 OCR 还没启用，store.ts 只记了 ocr_status='skipped'）：
    // 补一条新任务，attempts 用建表默认值 0
    run('INSERT INTO ocr_item (artifact_id, status) VALUES (?, ?)', [artifactId, 'pending']);
  }
  run('UPDATE artifact SET ocr_status = ? WHERE id = ?', ['pending', artifactId]);
  return { queued: true, status: 'pending', previousStatus, previousAttempts };
}

/**
 * 批量登记：把库里所有还没 OCR 过的图片/PDF 都排上。
 *
 * 要捞三类行：
 *   1. `ocr_status IS NULL / 'pending' / 'failed'` —— 常规待识别，以及可重试的失败项；
 *   2. `ocr_status = 'skipped'` 且**没有** ocr_item 记录 —— 这只有一种来历：上传时 OCR 还没启用，
 *      store.ts 只能记一个 'skipped'、也不建任务。用户后来才打开 OCR 开关、再点「扫描未识别」，
 *      以前这批照片一个都排不上队，界面回"没有需要识别的文件"，可照片里一个字都没识别过；
 *   3. 「识别完了但没文字」「用户取消」这类也是 'skipped'，但它们**有** ocr_item 记录，
 *      被第 2 条的 `i.id IS NULL` 挡在外面，不会每次点都被重新排队。
 *
 * 带 `attempts < 3` 过滤：失败项以前每次点「扫描未识别」都会被无限重新排队，
 * 一个坏文件能让队列永远转不完。
 */
export function enqueueMissing(): number {
  const rows = all<{ id: number; file_name: string; ocr_status: string | null; attempts: number | null; item_id: number | null }>(
    `SELECT a.id, a.file_name, a.ocr_status, i.attempts, i.id AS item_id
       FROM artifact a LEFT JOIN ocr_item i ON i.artifact_id = a.id
      WHERE a.deleted_at IS NULL
        AND (a.ocr_status IS NULL OR a.ocr_status IN ('pending','failed')
             OR (a.ocr_status = 'skipped' AND i.id IS NULL))`,
  );
  let n = 0;
  for (const r of rows) {
    if (!isOcrCandidate(r.file_name)) continue;
    if ((r.attempts ?? 0) >= 3) continue; // 试过三次还不行就算了，别无限重试
    // 补排队的 skipped 行得先确认真的能识别（见 canStillOcr）
    if (r.item_id === null && !canStillOcr(r.id, r.file_name)) continue;
    enqueueOcr(r.id);
    n += 1;
  }
  return n;
}

/**
 * 没有任务记录的 `skipped` 文件还能不能补排队。
 *
 * 光看扩展名会踩到一个坑：扩展名是图片、内容却不是的文件（改名上传）也是 `skipped` 且无记录，
 * 而它送进 tesseract 会以**抓不住的未捕获异常**把整个服务带崩（理由见 store.ts 的 looksLikeImage）。
 * 所以图片先验一下文件头；PDF 照旧放行（引擎不支持时会正常报错，不会崩）。
 */
function canStillOcr(artifactId: number, fileName: string): boolean {
  if (extname(fileName).toLowerCase() === '.pdf') return true;
  const a = getArtifact(artifactId);
  if (!a) return false;
  try {
    const fd = openSync(artifactAbsPath(a), 'r');
    try {
      const head = Buffer.alloc(16);
      const read = readSync(fd, head, 0, 16, 0);
      return read > 0 && looksLikeImage(head.subarray(0, read), a.file_name);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/* ------------------------------ 执行 ------------------------------ */

/**
 * 记一条「OCR 失败」健康事件（清单 B4-11 的事件类型之一是 `ocrFailure`，此前**没有任何调用点**）。
 *
 * 为什么必须补上：真实事故是"**一张损坏图片让 OCR 队列抛出未捕获异常 → 服务进程退出**"。
 * 修好之后异常不再杀进程了（`ocr.ts` 的 `errorHandler` + `index.ts` 的 uncaughtException 兜底），
 * 但光靠 `uncaughtException` 兜底的话，它落下的事件 kind 是 `uncaughtException` ——
 * 用户在首页「运行状态」卡片里看到的是"某处有个异常"，**看不出是 OCR、更看不出是哪张图**。
 * 所以在那条任务被判失败的那一刻，用它**同一条可读原因**再记一笔 `ocrFailure`。
 *
 * 三条边界（都不要越过）：
 *   1. **只为"判为失败"记录**：识别成功（done）与正常跳过（skipped：PDF/无文字/已取消）都不记，
 *      否则事件列表会被正常业务噪声填满，"失败要响"就变成了"什么都响"。
 *   2. **`recordHealthEvent` 自身不抛错**（core/health.ts 的保证：表不存在/库没开/写失败都只是
 *      降级为仅内存），所以这里**不需要** try/catch —— 再加一层只会让人以为它会抛。
 *   3. **不改失败处理语义**：只调用记录函数，`ocr_item` 状态、`ocr_error` 文案、
 *      "继续处理下一条"的队列行为全都不动。
 *
 * @param artifactId 出问题的文件记录 id（写进 message，便于在首页定位是哪张图）
 * @param reason     与写进 `ocr_item.ocr_error`、界面显示的**同一条**可读原因
 */
function recordOcrFailure(artifactId: number, reason: string): void {
  // 文件名/artifact id 由这里补上：失败原因本身（"图片损坏，无法识别（…）"）不含是哪个文件
  const a = getArtifact(artifactId);
  const which = a ? `${a.file_name}（artifact #${a.id}）` : `artifact #${artifactId}（记录已不在）`;
  recordHealthEvent({ kind: 'ocrFailure', message: `OCR 失败：${reason}｜文件：${which}` });
}

export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (;;) {
      /**
       * 原子领取：先 `UPDATE ... WHERE status='pending'` 把状态抢过来，
       * 只有 changes===1 才算领到。原来是无条件 SELECT 出来再改状态 ——
       * 进程内靠 `processing` 挡得住，但**两个 node 进程并存时**
       * （比如 npm run dev 与 npm start 同时开着）会对同一行重复识别，
       * 白烧 CPU 还可能写坏状态。
       */
      const candidate = get<OcrItem>("SELECT * FROM ocr_item WHERE status = 'pending' ORDER BY id LIMIT 1");
      if (!candidate) break;
      const claimed = run(
        `UPDATE ocr_item SET status = 'running', attempts = attempts + 1,
           started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'pending'`,
        [candidate.id],
      );
      if (Number(claimed.changes) !== 1) continue; // 被别的进程抢走了
      /**
       * 单条任务的失败**绝不能**打断这个 for(;;)：
       * 一个坏文件不该让后面排队的文件永远轮不到（验收问题 A 的另一半 ——
       * 光是"服务不退出"还不够，队列也得走下去）。
       * 所以这里把任何异常落成这条任务的失败原因，然后继续领下一条。
       */
      try {
        await runOne(candidate);
      } catch (e) {
        failItem(candidate.id, candidate.artifact_id, e);
      }
    }
  } finally {
    processing = false;
  }
}

/**
 * 把一条任务落成 failed 并写上可读原因。
 *
 * 「写失败原因」这一步自己也用 try 包住：连它都写不进库（数据库忙、锁、行没了）时，
 * 至少不要把异常再抛出去带走整个队列 —— 记一行日志，继续处理后面的任务。
 */
function failItem(itemId: number, artifactId: number, e: unknown): void {
  const reason = summarizeOcrError(e);
  /**
   * B4-11：在"判为失败"的这一刻记一笔 `ocrFailure` 事件。
   * 这里是 `runOne` 抛出来的任何异常（失败点 ①，含识别超时）唯一的汇合点。
   * 记在 `finish()` **之前**：`finish()` 若抛（数据库忙/锁/行没了），
   * `ocr_item` 的 failed 落不下去，但"这张图出过事"仍然要留在事件列表里 —— 那正是本次要修的静默。
   */
  recordOcrFailure(artifactId, reason);
  try {
    finish(itemId, artifactId, 'failed', null, 0, reason);
  } catch (e2) {
    lastMessage = `OCR 失败：${reason}`;
    console.error(`[OCR] 任务 #${itemId} 的失败原因写不进库：${summarizeOcrError(e2)}（原失败原因：${reason}）`);
  }
}

async function runOne(item: OcrItem): Promise<void> {
  const a = getArtifact(item.artifact_id);
  if (!a) {
    run("UPDATE ocr_item SET status = 'skipped', ocr_error = '文件记录已删除' WHERE id = ?", [item.id]);
    return;
  }
  run('UPDATE artifact SET ocr_status = ? WHERE id = ?', ['running', a.id]);

  const abs = artifactAbsPath(a);
  if (!existsSync(abs)) {
    const reason = `文件已不在磁盘上：${a.file_rel}`;
    recordOcrFailure(a.id, reason); // B4-11：失败点 ②（文件被删/被挪走：判 failed，不是 skipped）
    finish(item.id, a.id, 'failed', null, 0, reason);
    return;
  }

  const r = await ocrFile(abs);
  if (!r.ok) {
    const reason = r.error ?? '识别失败';
    recordOcrFailure(a.id, reason); // B4-11：失败点 ③（引擎报错/识别超时，reason 即 ocr.ts 给的可读原因）
    finish(item.id, a.id, 'failed', null, 0, reason);
    return;
  }
  if (!r.text.trim()) {
    // 多页 PDF 或纯图片无文字：WASM 版引擎不支持 PDF，给出可执行建议
    const hint = a.file_ext === '.pdf' ? '未识别到文字。本机 OCR 引擎不支持直接读 PDF，请把扫描页导出为 JPG/PNG 后再上传。' : '未识别到文字（图片可能是纯图形或分辨率过低）。';
    finish(item.id, a.id, 'skipped', null, 0, hint);
    return;
  }
  finish(item.id, a.id, 'done', r.confidence, r.text.length, null, r.text);
  lastMessage = `${a.file_name}：识别 ${r.text.length} 字，置信度 ${r.confidence}，用时 ${r.ms}ms`;
}

function finish(
  itemId: number,
  artifactId: number,
  status: 'done' | 'failed' | 'skipped',
  confidence: number | null,
  chars: number,
  error: string | null,
  text?: string,
): void {
  run(
    `UPDATE ocr_item SET status = ?, confidence = ?, chars = ?, ocr_error = ?,
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [status, confidence, chars, error, itemId],
  );
  if (text !== undefined) {
    run('UPDATE artifact SET ocr_text = ?, ocr_status = ? WHERE id = ?', [text, status, artifactId]);
  } else {
    run('UPDATE artifact SET ocr_status = ? WHERE id = ?', [status, artifactId]);
  }
  indexArtifact(artifactId);
  if (error) lastMessage = `OCR ${status === 'failed' ? '失败' : '跳过'}：${error}`;
}

/* ------------------------------ 查询 ------------------------------ */

export function queueState(limit = 30): OcrQueueState {
  const counts = all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ocr_item GROUP BY status');
  const pick = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const items = all<OcrItem & { file_name: string; title: string; workbench_id: number | null }>(
    `SELECT o.*, a.file_name, a.title, a.workbench_id
       FROM ocr_item o JOIN artifact a ON a.id = o.artifact_id
      WHERE a.deleted_at IS NULL
      ORDER BY CASE o.status WHEN 'running' THEN 1 WHEN 'pending' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END, o.id DESC
      LIMIT ?`,
    [limit],
  );
  return {
    enabled: ocrEnabled(),
    pending: pick('pending'),
    running: pick('running'),
    done: pick('done'),
    failed: pick('failed'),
    skipped: pick('skipped'),
    items,
    lastMessage,
  };
}

export function cancelPending(): number {
  const r = run("UPDATE ocr_item SET status = 'skipped', ocr_error = '已取消' WHERE status = 'pending'");
  run("UPDATE artifact SET ocr_status = 'skipped' WHERE ocr_status = 'pending'");
  return r.changes;
}

/** 单个文件的 OCR 状态，给界面用 */
export function artifactOcrState(a: Artifact): { status: string; chars: number; error: string | null } {
  const item = get<OcrItem>('SELECT * FROM ocr_item WHERE artifact_id = ?', [a.id]);
  return {
    status: item?.status ?? a.ocr_status ?? 'none',
    chars: (a.ocr_text ?? '').length,
    error: item?.ocr_error ?? null,
  };
}

export function ocrSummary(): { enabled: boolean; candidates: number; needOcr: number } {
  // 回收站里的文件不算候选、也不算"还没识别" —— 它们不该出现在队列统计里
  const candidates = all<{ id: number; file_name: string }>('SELECT id, file_name FROM artifact WHERE deleted_at IS NULL')
    .filter((a) => isOcrCandidate(a.file_name)).length;
  const needOcr = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM artifact WHERE deleted_at IS NULL AND (ocr_status IS NULL OR ocr_status IN ('pending','failed'))",
  )?.n ?? 0;
  return { enabled: ocrEnabled(), candidates, needOcr };
}
