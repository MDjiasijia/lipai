/**
 * v2 分享文件校验/本地库测试(纯函数部分,不落盘)。
 * 锁死与 share-web validate.ts 同规则的边界。
 */
import { describe, it, expect } from 'vitest';
import { validateShareFile } from '../server/library.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 用内置预设帧造一张合法 135×240 JPEG base64。 */
function realFrame(): string {
  const frame = readFileSync(
    path.join(process.cwd(), 'public/gallery-presets/鲸娘数字手势/frame_0.jpg'),
  );
  return frame.toString('base64');
}

function galleryDoc(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: 'lipai-gallery',
      version: 2,
      galleries: [{ name: '测试', frames: [realFrame()] }],
      ...overrides,
    }),
  );
}

describe('validateShareFile —— v2 格式校验', () => {
  it('合法 gallery 文件通过,回读 shareMeta', () => {
    const out = validateShareFile(
      galleryDoc({ shareMeta: { title: '早安', tags: ['a', 'b'] } }),
    );
    expect(out.type).toBe('lipai-gallery');
    expect(out.title).toBe('早安');
    expect(out.tags).toEqual(['a', 'b']);
  });

  it('version !== 2 拒绝', () => {
    expect(() =>
      validateShareFile(galleryDoc({ version: 1 })),
    ).toThrowError(/version/);
  });

  it('非法 type 拒绝', () => {
    expect(() => validateShareFile(galleryDoc({ type: 'nope' }))).toThrowError(/type/);
  });

  it('非 JPEG 帧拒绝(magic 校验)', () => {
    const bad = new TextEncoder().encode(
      JSON.stringify({
        type: 'lipai-gallery',
        version: 2,
        galleries: [{ name: 'x', frames: [Buffer.from('notjpeg').toString('base64')] }],
      }),
    );
    expect(() => validateShareFile(bad)).toThrowError(/JPEG/);
  });

  it('位图宽高比越界拒绝(9:16±15%)', () => {
    // 造一张 200x200 的合法 JPEG:用 napi canvas 现画
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createCanvas } = require('@napi-rs/canvas') as {
      createCanvas: (w: number, h: number) => { toBuffer: (t: string) => Buffer };
    };
    const canvas = createCanvas(200, 200);
    const buf = canvas.toBuffer('image/jpeg');
    const doc = new TextEncoder().encode(
      JSON.stringify({
        type: 'lipai-gallery',
        version: 2,
        galleries: [{ name: 'x', frames: [buf.toString('base64')] }],
      }),
    );
    expect(() => validateShareFile(doc)).toThrowError(/宽高比|尺寸/);
  });

  it('槽位帧上限 10 / 图组上限 20', () => {
    const many = Array.from({ length: 11 }, () => realFrame());
    const doc = new TextEncoder().encode(
      JSON.stringify({
        type: 'lipai-gallery',
        version: 2,
        galleries: [{ name: 'x', frames: many }],
      }),
    );
    expect(() => validateShareFile(doc)).toThrowError(/最多/);
  });

  it('8MB 上限拒绝', () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    expect(() => validateShareFile(big)).toThrowError(/8MB/);
  });
});
