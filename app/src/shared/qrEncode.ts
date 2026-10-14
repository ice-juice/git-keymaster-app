import qrcode from "qrcode-generator";

type QrFactory = typeof qrcode & {
  stringToBytes?: (s: string) => number[];
  stringToBytesFuncs?: Record<string, (s: string) => number[]>;
};

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function makeQr(text: string) {
  const factory = qrcode as QrFactory;
  factory.stringToBytes = factory.stringToBytesFuncs?.["UTF-8"] ?? utf8Bytes;
  const qr = factory(0, "M");
  qr.addData(text);
  qr.make();
  return qr;
}

/** 可缩放 SVG。margin 默认 2；光传直播传入 4 格静区。 */
export function encodeQrSvg(text: string, margin = 2): string {
  return makeQr(text).createSvgTag({ cellSize: 4, margin, scalable: true });
}

/** 与 encodeQrSvg 同一套纠错和字节模式，用来核对光传帧的模块数。 */
export function qrModuleCount(text: string): number {
  return makeQr(text).getModuleCount();
}

/** GIF data URL，需要 <img> 时用。 */
export function encodeQrDataUrl(text: string): string {
  return makeQr(text).createDataURL(4, 2);
}
