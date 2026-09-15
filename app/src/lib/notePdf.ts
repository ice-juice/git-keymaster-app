const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const SCALE = 2;
const FONT =
  '"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Segoe UI",system-ui,sans-serif';

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "image"; src: string; alt: string };

function stripInline(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }
    const img = line.match(/^!\[([^\]]*)\]\((data:[^)]+|kmasset:\/\/[0-9a-fA-F]{64})\)\s*$/);
    if (img) {
      blocks.push({ type: "image", alt: img[1], src: img[2] });
      i += 1;
      continue;
    }
    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: stripInline(heading[2]) });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(stripInline(lines[i].replace(/^\s*>\s?/, "")));
        i += 1;
      }
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(stripInline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s+|\s*>|!\[)/.test(lines[i])) {
      buf.push(stripInline(lines[i]));
      i += 1;
    }
    if (buf.length) blocks.push({ type: "para", text: buf.join(" ") });
  }
  return blocks;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const ch of raw) {
      const next = cur + ch;
      if (cur && ctx.measureText(next).width > maxWidth) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [""];
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (!src.startsWith("data:")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function newPage(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(PAGE_W * SCALE);
  canvas.height = Math.round(PAGE_H * SCALE);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("PDF 页面编码失败"));
          return;
        }
        void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      "image/jpeg",
      0.92,
    );
  });
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function pad10(n: number): string {
  return n.toString().padStart(10, "0");
}

function jpegPagesToPdf(pages: { jpeg: Uint8Array }[]): Uint8Array {
  const objs: Uint8Array[] = [];
  const kids: string[] = [];
  let next = 3;
  for (let i = 0; i < pages.length; i++) {
    const pageNo = next;
    const contentNo = next + 1;
    const imgNo = next + 2;
    next += 3;
    kids.push(`${pageNo} 0 R`);
    const content = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`;
    objs[pageNo] = ascii(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imgNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`,
    );
    objs[contentNo] = ascii(
      `${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    );
    objs[imgNo] = concat([
      ascii(
        `${imgNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.round(PAGE_W * SCALE)} /Height ${Math.round(PAGE_H * SCALE)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pages[i].jpeg.length} >>\nstream\n`,
      ),
      pages[i].jpeg,
      ascii(`\nendstream\nendobj\n`),
    ]);
  }
  objs[1] = ascii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objs[2] = ascii(
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );

  const chunks: Uint8Array[] = [ascii("%PDF-1.4\n")];
  const offsets = [0];
  let pos = chunks[0].length;
  const maxObj = next - 1;
  for (let i = 1; i <= maxObj; i++) {
    offsets[i] = pos;
    const body = objs[i];
    chunks.push(body);
    pos += body.length;
  }
  const xrefAt = pos;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) xref += `${pad10(offsets[i])} 00000 n \n`;
  xref += `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(ascii(xref));
  return concat(chunks);
}

export async function markdownToPdfBytes(title: string, markdown: string): Promise<Uint8Array> {
  const blocks = parseBlocks(markdown);
  const pages: HTMLCanvasElement[] = [];
  let canvas = newPage();
  let ctx = canvas.getContext("2d")!;
  const maxW = (PAGE_W - MARGIN * 2) * SCALE;
  const maxY = (PAGE_H - MARGIN) * SCALE;
  let y = MARGIN * SCALE;

  function ensure(h: number) {
    if (y + h <= maxY) return;
    pages.push(canvas);
    canvas = newPage();
    ctx = canvas.getContext("2d")!;
    y = MARGIN * SCALE;
  }

  function drawLines(lines: string[], size: number, color: string, lineH: number, padLeft = 0) {
    ctx.fillStyle = color;
    ctx.font = `${size}px ${FONT}`;
    for (const line of lines) {
      ensure(lineH);
      ctx.fillText(line, MARGIN * SCALE + padLeft, y + size);
      y += lineH;
    }
  }

  ctx.fillStyle = "#111827";
  ctx.font = `700 ${20 * SCALE}px ${FONT}`;
  const titleLines = wrapText(ctx, title.trim() || "note", maxW);
  drawLines(titleLines, 20 * SCALE, "#111827", 26 * SCALE);
  y += 10 * SCALE;
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1 * SCALE;
  ensure(12 * SCALE);
  ctx.beginPath();
  ctx.moveTo(MARGIN * SCALE, y);
  ctx.lineTo((PAGE_W - MARGIN) * SCALE, y);
  ctx.stroke();
  y += 16 * SCALE;

  for (const block of blocks) {
    if (block.type === "hr") {
      ensure(16 * SCALE);
      ctx.strokeStyle = "#d1d5db";
      ctx.lineWidth = 1 * SCALE;
      ctx.beginPath();
      ctx.moveTo(MARGIN * SCALE, y + 6 * SCALE);
      ctx.lineTo((PAGE_W - MARGIN) * SCALE, y + 6 * SCALE);
      ctx.stroke();
      y += 16 * SCALE;
      continue;
    }
    if (block.type === "heading") {
      const size = (block.level <= 1 ? 18 : block.level === 2 ? 15 : 13) * SCALE;
      ctx.font = `700 ${size}px ${FONT}`;
      drawLines(wrapText(ctx, block.text, maxW), size, "#111827", size + 8 * SCALE);
      y += 6 * SCALE;
      continue;
    }
    if (block.type === "para") {
      ctx.font = `${11 * SCALE}px ${FONT}`;
      drawLines(wrapText(ctx, block.text, maxW), 11 * SCALE, "#1f2937", 16 * SCALE);
      y += 8 * SCALE;
      continue;
    }
    if (block.type === "quote") {
      ctx.font = `${11 * SCALE}px ${FONT}`;
      const lines = wrapText(ctx, block.text, maxW - 16 * SCALE);
      const h = lines.length * 16 * SCALE + 8 * SCALE;
      ensure(h);
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(MARGIN * SCALE, y, 4 * SCALE, h);
      drawLines(lines, 11 * SCALE, "#4b5563", 16 * SCALE, 12 * SCALE);
      y += 8 * SCALE;
      continue;
    }
    if (block.type === "code") {
      ctx.font = `${10 * SCALE}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      const lines = wrapText(ctx, block.text || " ", maxW - 16 * SCALE);
      const h = lines.length * 14 * SCALE + 16 * SCALE;
      ensure(h);
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(MARGIN * SCALE, y, maxW, h);
      y += 8 * SCALE;
      drawLines(lines, 10 * SCALE, "#111827", 14 * SCALE, 8 * SCALE);
      y += 8 * SCALE;
      continue;
    }
    if (block.type === "list") {
      ctx.font = `${11 * SCALE}px ${FONT}`;
      block.items.forEach((item, idx) => {
        const mark = block.ordered ? `${idx + 1}. ` : "• ";
        const lines = wrapText(ctx, mark + item, maxW - 8 * SCALE);
        drawLines(lines, 11 * SCALE, "#1f2937", 16 * SCALE, 8 * SCALE);
      });
      y += 8 * SCALE;
      continue;
    }
    const img = await loadImage(block.src);
    if (!img) {
      ctx.font = `${11 * SCALE}px ${FONT}`;
      drawLines(wrapText(ctx, block.alt ? `[${block.alt}]` : "[image]", maxW), 11 * SCALE, "#6b7280", 16 * SCALE);
      y += 8 * SCALE;
      continue;
    }
    const ratio = img.height / Math.max(img.width, 1);
    let w = Math.min(maxW, img.width * SCALE);
    let h = w * ratio;
    const maxH = (PAGE_H - MARGIN * 2) * SCALE;
    if (h > maxH) {
      h = maxH;
      w = h / ratio;
    }
    ensure(h + 12 * SCALE);
    ctx.drawImage(img, MARGIN * SCALE, y, w, h);
    y += h + 12 * SCALE;
  }

  pages.push(canvas);
  const jpegs = [];
  for (const page of pages) jpegs.push({ jpeg: await canvasToJpeg(page) });
  return jpegPagesToPdf(jpegs);
}
