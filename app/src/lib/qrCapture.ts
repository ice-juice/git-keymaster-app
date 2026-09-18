import jsQR from "jsqr";
import { api } from "./ipc";
export { scanQrWithCamera } from "../ui/QrScannerDialog";

/**
 * 从图片文件中解码二维码文本。
 * 三重解码保障：
 * 1. 优先使用浏览器原生硬件加速的 BarcodeDetector（Android Chromium 83+ 原生内置，极速、抗倾斜反光）
 * 2. 备用纯 JS 的 jsQR 解码（毫秒级 CPU 处理）
 * 3. 底层 Rust rqrr 解码器
 */
export async function decodeQrFromImageBlob(blob: Blob): Promise<string[]> {
  // 1. 尝试使用浏览器原生 BarcodeDetector
  if ("BarcodeDetector" in window) {
    try {
      const imgBitmap = await createImageBitmap(blob);
      const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
      const barcodes = await detector.detect(imgBitmap);
      const hits = barcodes.map((b: any) => b.rawValue).filter(Boolean);
      if (hits.length > 0) return hits;
    } catch {
      // 降级到 jsQR
    }
  }

  // 2. 尝试使用 jsQR 解码 Canvas
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = url;
    });
    URL.revokeObjectURL(url);

    const canvas = document.createElement("canvas");
    // 对手机高像素原图进行适度等比缩放（限制长边最大 1280），避免像素过渡平滑导致二维码网格失真
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(imgData.data, canvas.width, canvas.height, {
        inversionAttempts: "attemptBoth",
      });
      if (res && res.data && res.data.trim()) {
        return [res.data.trim()];
      }
    }
  } catch {
    // 降级到 Rust
  }

  // 3. 底层 Rust rqrr 解码
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return await api.decodeQrFromImage(Array.from(bytes));
  } catch {
    return [];
  }
}

/** 打开系统文件选择器，从相册选择一张图片 */
export function pickImageFromGallery(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    // iOS WKWebView 必须挂到 DOM 才能稳定唤起相册；不要设 capture，否则会直接开相机。
    input.setAttribute("autocomplete", "off");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.onchange = () => {
      done(input.files?.[0] || null);
    };
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** 从相册选图并解码其中的二维码文本。 */
export async function pickQrFromGallery(): Promise<string[] | null> {
  const file = await pickImageFromGallery();
  if (!file) return null;
  return decodeQrFromImageBlob(file);
}

/** 从已有字节流中解码二维码（供桌面或剪贴板使用） */
export async function decodeQrFromBytes(bytes: Uint8Array): Promise<string[]> {
  const blob = new Blob([bytes as BlobPart]);
  return decodeQrFromImageBlob(blob);
}

function isTotpImportUri(text: string): boolean {
  const s = text.trim().toLowerCase();
  return s.startsWith("otpauth-migration://") || s.startsWith("otpauth://");
}

/** 提取首个有效 OTPAuth / Google 导出链接 */
export function firstOtpauth(texts: string[]): string | null {
  const uris = totpImportUris(texts);
  return uris[0] || null;
}

/** 提取全部可导入的 2FA 链接（含 Google 身份验证器导出） */
export function totpImportUris(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const s = t.trim();
    if (isTotpImportUri(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 提取首个有效 S3/R2 云存储配置 JSON */
export function firstS3ConfigJson(texts: string[]): string | null {
  for (const t of texts) {
    let s = t.trim();
    if (s.startsWith("```")) {
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    }
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") {
        if (obj.kind === "git-keymaster-s3" || obj.kind === "git-account-manager-s3") {
          return s;
        }
        if (obj.config && (obj.config.endpoint || obj.config.bucket)) {
          return s;
        }
        if (obj.endpoint && obj.bucket) {
          return s;
        }
      }
    } catch {
      // 容错匹配纯文本正则
    }
    if (s.startsWith("{") && /git-keymaster-s3|git-account-manager-s3|"endpoint"/.test(s)) {
      return s;
    }
  }
  return null;
}
