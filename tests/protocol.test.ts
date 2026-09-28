/**
 * IPS 协议层测试：帧编解码往返、校验和、时间戳字节序、SSID 校验。
 * protocol.ts 锁死编码语义（帧结构/校验和/时间戳字节序）。
 */
import { describe, it, expect } from 'vitest';
import {
  BLE,
  Command,
  checksum,
  packet,
  decodePacket,
  hex,
  text,
  timestampBytes,
  validateSsid,
  commandName,
} from '../src/lib/ips/protocol.js';
import {
  sanitizeLoopSteps,
  isSlotStep,
  loopStepPushesImages,
} from '../server/shared/index.js';

describe('protocol —— 帧编解码', () => {
  it('帧结构：A5 | cmd | payload | checksum | 5A', () => {
    const frame = packet(Command.setClockStyle, [3]);
    expect(frame[0]).toBe(0xa5);
    expect(frame[1]).toBe(Command.setClockStyle);
    expect(frame.at(-1)).toBe(0x5a);
    expect(frame.length).toBe(5);
    expect(checksum(Command.setClockStyle, [3])).toBe(frame.at(-2));
  });

  it('解码往返：响应帧 status(0=成功) + body', () => {
    const body = [0x56, 0x31, 0x2e, 0x32]; // "V1.2"
    const bytes = Uint8Array.from([
      0xa5,
      Command.getFirmwareVersion,
      0, // status
      ...body,
      checksum(Command.getFirmwareVersion, [0, ...body]),
      0x5a,
    ]);
    const decoded = decodePacket(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    expect(decoded?.command).toBe(Command.getFirmwareVersion);
    expect(decoded?.checksumValid).toBe(true);
    expect(text(decoded!.payload.slice(1))).toBe('V1.2');
  });

  it('坏校验帧：checksumValid=false 但不抛错', () => {
    const bytes = Uint8Array.from([
      0xa5,
      Command.getFirmwareVersion,
      0,
      1,
      2,
      0xff, // 错误校验
      0x5a,
    ]);
    const decoded = decodePacket(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    expect(decoded?.checksumValid).toBe(false);
  });

  it('时间戳 4 字节大端 hex', () => {
    const ts = timestampBytes(1_725_148_800);
    expect(ts).toHaveLength(4);
    expect(Array.from(ts)).toEqual([0x66, 0xd3, 0xae, 0x80]); // hex(1725148800)=0x66d3ae80
  });

  it('MTU 500：分包帧 500B + 4B 帧开销', () => {
    expect(BLE.mtu).toBe(500);
    const payload = new Uint8Array(500);
    const frame = packet(Command.imageData, payload);
    expect(frame.length).toBe(500 + 4);
  });

  it('SSID 校验：非 ASCII 拒绝', () => {
    expect(validateSsid('')).toBeTruthy();
    expect(validateSsid('家里WiFi')).toBeTruthy();
    expect(validateSsid('Home-Wifi')).toBeUndefined();
  });

  it('hex 输出大写两位', () => {
    expect(hex(Uint8Array.from([0x0a, 0xbc]))).toBe('0A BC');
  });

  it('commandName 反查', () => {
    expect(commandName(Command.setClockStyle)).toBe('setClockStyle');
    expect(commandName(200)).toBe('cmd_200');
  });
});

describe('loop steps —— 清洗与分类', () => {
  it('数字 0-3 是切槽位步', () => {
    expect(isSlotStep(1)).toBe(true);
    expect(isSlotStep('weather')).toBe(false);
    expect(loopStepPushesImages(2)).toBe(false);
    expect(loopStepPushesImages('weather')).toBe(true);
  });

  it('清洗：剔非法/去重/保序;用量/额度系源名保留', () => {
    expect(sanitizeLoopSteps([2, 'weather', 99, 'nope', 2, 'gallery'])).toEqual([
      2,
      'weather',
      'gallery',
    ]);
    expect(sanitizeLoopSteps(['usage-credit'])).toEqual(['usage-credit']);
    expect(sanitizeLoopSteps(null)).toEqual([]);
  });
});
