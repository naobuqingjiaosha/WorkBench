/**
 * 上传辅助：把 multipart 文件安全地落到数据目录
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import type { MultipartFile } from '@fastify/multipart';
import { ApiError } from './reply.ts';
import { safeName } from '../core/paths.ts';

const ALLOWED_EXT = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.xlsm', '.pptx', '.ppt', '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
  '.txt', '.md', '.csv', '.json', '.zip', '.rar', '.7z',
]);

export interface SavedUpload {
  tempPath: string;
  fileName: string;
  ext: string;
  size: number;
  mime: string;
}

function tempDir(): string {
  const dir = join(tmpdir(), 'workbench-upload');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把上传流写到临时文件，返回路径与元信息 */
export async function saveUploadToTemp(part: MultipartFile): Promise<SavedUpload> {
  const rawName = part.filename || 'upload.bin';
  const fileName = safeName(rawName, 'upload.bin');
  const ext = (fileName.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    throw new ApiError('BAD_EXT', `不支持的文件类型：${ext}`);
  }
  const tempPath = join(tempDir(), `${randomUUID()}${ext || '.bin'}`);
  try { await pipeline(part.file, createWriteStream(tempPath,{flags:'wx'})); } catch(e) {cleanupTemp(tempPath);throw e;}
  if (part.file.truncated) {
    rmSync(tempPath, { force: true });
    throw new ApiError('TOO_LARGE', `文件超过大小限制（${fileName}）`);
  }
  return { tempPath, fileName, ext, size: (part.file as unknown as { bytesRead?: number }).bytesRead ?? 0, mime: part.mimetype };
}

export function cleanupTemp(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 忽略 */
  }
}

/** 从 multipart 请求里同时取字段和文件 */
export async function readParts(req: import('fastify').FastifyRequest): Promise<{ fields: Record<string, string>; files: SavedUpload[] }> {
  const fields: Record<string, string> = {};
  const files: SavedUpload[] = [];
  if (!req.isMultipart()) throw new ApiError('NOT_MULTIPART', '请使用 multipart/form-data 上传');
  try {
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      files.push(await saveUploadToTemp(part));
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, files };
  } catch(e) {for(const f of files)cleanupTemp(f.tempPath);throw e;}
}
