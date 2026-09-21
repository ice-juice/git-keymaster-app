/** 按 MIME / 扩展名显示彩色类型徽标，不依赖内置站点图标 id。 */

const KINDS: { test: RegExp; label: string; color: string }[] = [
  { test: /(pdf)$/i, label: "PDF", color: "#dc2626" },
  { test: /(zip|rar|7z|tar|gz|tgz)$/i, label: "ZIP", color: "#d97706" },
  { test: /(png|jpe?g|gif|webp|bmp|svg|heic|ico)$/i, label: "IMG", color: "#2563eb" },
  { test: /(pem|key|ppk|p12|pfx|crt|cer)$/i, label: "KEY", color: "#059669" },
  { test: /(docx?|rtf|odt)$/i, label: "DOC", color: "#4f46e5" },
  { test: /(xlsx?|csv|ods)$/i, label: "XLS", color: "#0f766e" },
  { test: /(pptx?|odp)$/i, label: "PPT", color: "#c2410c" },
  { test: /(txt|md|log|json|xml|html?|css|js)$/i, label: "TXT", color: "#4338ca" },
  { test: /(mp4|mov|webm|mkv)$/i, label: "VID", color: "#7c3aed" },
  { test: /(mp3|wav|flac|aac)$/i, label: "AUD", color: "#0ea5e9" },
];

function extOf(name?: string | null): string {
  const n = (name || "").trim();
  const i = n.lastIndexOf(".");
  return i >= 0 ? n.slice(i + 1) : "";
}

export function fileKind(entry: { originalName?: string | null; name?: string | null; mime?: string | null }) {
  const ext = extOf(entry.originalName) || extOf(entry.name);
  const mime = (entry.mime || "").toLowerCase();
  const hit =
    KINDS.find((k) => ext && k.test.test(ext)) ||
    KINDS.find((k) => (mime.startsWith("image/") && k.label === "IMG") || (mime === "application/pdf" && k.label === "PDF"));
  return hit || { label: (ext || "FILE").slice(0, 4).toUpperCase(), color: "#6366f1" };
}

export function FileIconMark({
  originalName,
  name,
  mime,
  size = 40,
}: {
  originalName?: string | null;
  name?: string | null;
  mime?: string | null;
  size?: number;
}) {
  const kind = fileKind({ originalName, name, mime });
  return (
    <div
      className="file-icon-mark"
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        background: kind.color,
        color: "#fff",
        fontSize: size < 32 ? 9 : 11,
        fontWeight: 800,
        letterSpacing: 0.3,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: `0 0 ${size}px`,
      }}
    >
      {kind.label}
    </div>
  );
}
