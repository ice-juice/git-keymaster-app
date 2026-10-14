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

/** 可缩放 SVG，给弹层里的二维码预览用。 */
export function encodeQrSvg(text: string): string {
  return makeQr(text).createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** GIF data URL，需要 <img> 时用。 */
export function encodeQrDataUrl(text: string): string {
  return makeQr(text).createDataURL(4, 2);
}
