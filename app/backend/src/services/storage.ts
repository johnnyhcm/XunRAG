// 文件存储助手：data/uploads/{libId}/{versionId}/{原文件名}（永存不修改，D1）
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export function uploadsRoot(): string {
  return path.join(config.root, 'data', 'uploads');
}

export function versionUploadDir(libraryId: string, versionId: string): string {
  const dir = path.join(uploadsRoot(), libraryId, versionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveOriginalFile(
  libraryId: string,
  versionId: string,
  originalName: string,
  data: Buffer,
): { storedPath: string; storedName: string } {
  const dir = versionUploadDir(libraryId, versionId);
  // 防路径穿越：仅用 basename
  const safe = path.basename(originalName).replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
  const fp = path.join(dir, safe);
  fs.writeFileSync(fp, data);
  return { storedPath: fp, storedName: safe };
}