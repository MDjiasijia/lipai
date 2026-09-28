export const BLE = {
  service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  mtu: 500,
} as const,
 Command = {
  rebootDevice: 48,
  factoryReset: 49,
  setUpgradeMode: 50,
  getFirmwareVersion: 51,
  getDeviceStorage: 52,
  getHardwareVersion: 53,
  setFirmwareAddress: 55,
  getWifiSsid: 64,
  getWifiStatus: 68,
  setWifiSsid: 65,
  setWifiPassword: 67,
  setWifiStatus: 69,
  getWifiMac: 70,
  getWifiIp: 71,
  getNetworkTime: 80,
  setNetworkTime: 81,
  getTimeZone: 82,
  setTimeZone: 83,
  getTimeFormat: 86,
  setTimeFormat: 87,
  getTimestamp: 88,
  setTimestamp: 89,
  getClockStyle: 90,
  setClockStyle: 91,
  getLightMode: 96,
  setLightMode: 97,
  getLightColor: 98,
  setLightColor: 99,
  getLightBrightness: 100,
  setLightBrightness: 101,
  getWeatherVisible: 112,
  setWeatherVisible: 113,
  getWeatherLocation: 114,
  setWeatherLocation: 115,
  getTemperatureUnit: 116,
  setTemperatureUnit: 117,
  imageStart: 144,
  imageData: 145,
  imageEnd: 146,
  imageSum: 147,
} as const;

export type DecodedPacket = { command: number; payload: Uint8Array; checksumValid: boolean };

// Reverse lookup of command id → readable name, for diagnostic logging.
export function commandName(id: number): string {
  const entry = Object.entries(Command).find(([, value]) => value === id);
  return entry ? entry[0] : `cmd_${id}`;
}

export function checksum(command: number, payload: Iterable<number> = []): number {
  let value = command;
  for (const byte of payload) value += byte;
  return value & 0xff;
}

export function packet(command: number, payload: Iterable<number> = []): Uint8Array {
  const body = Uint8Array.from(payload);
  return Uint8Array.from([0xa5, command, ...body, checksum(command, body), 0x5a]);
}

export function decodePacket(value: DataView): DecodedPacket | null {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
   command = bytes[1] ?? 0,
   payload = bytes.slice(2, -2);
  if (bytes.length < 4 || bytes[0] !== 0xa5 || bytes.at(-1) !== 0x5a) return null;
  return { command, payload, checksumValid: checksum(command, payload) === bytes.at(-2) };
}

export function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(" ").toUpperCase();
}

export function text(payload: Uint8Array): string {
  return new TextDecoder().decode(payload).replaceAll('\0', "").trim();
}

export function timestampBytes(timestamp: number): Uint8Array {
  const hexValue = Math.floor(timestamp).toString(16).padStart(8, "0");
  return Uint8Array.from(hexValue.match(/.{1,2}/g)!.map((value) => Number.parseInt(value, 16)));
}

export function validateSsid(ssid: string): string | undefined {
  if (!ssid) return "请输入 Wi‑Fi 名称。";
  if (/[^\x20-\x7e]/.test(ssid)) return "当前设备协议仅支持 ASCII Wi‑Fi 名称。";
  return undefined;
}
