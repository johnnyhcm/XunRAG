// 调用 Python /convert（TECH.md §3.3）。S2：Word→MD + HTML + 分段 + 语言检测
import { config } from '../config.js';
import { getNumber } from './config.js';

export interface ConvertSegment {
  index: number;
  text: string;
  lang: string;
  type: 'body' | 'cover' | 'toc' | 'header_footer';
}
export interface ConvertImage {
  original_name: string;
  stored_path: string;
  position: number;
}
export interface ConvertResult {
  markdown: string;
  html: string;
  segments: ConvertSegment[];
  images: ConvertImage[];
  quality: 'ok' | 'need_review';
}

export async function callPythonConvert(
  filePath: string,
  mediaDir?: string,
): Promise<ConvertResult> {
  const url = `${config.pythonBaseUrl}/convert`;
  const body = JSON.stringify({ file_path: filePath, media_dir: mediaDir });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), getNumber('convert.timeout_ms', 120_000));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Python /convert ${res.status}: ${txt}`);
    }
    return (await res.json()) as ConvertResult;
  } finally {
    clearTimeout(t);
  }
}