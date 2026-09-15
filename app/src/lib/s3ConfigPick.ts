import { open } from "@tauri-apps/plugin-dialog";
import { api, type S3Config } from "./ipc";
import { isMobilePlatform } from "./platform";

/** 与 Rust `identity::S3_KIND` / 导出 JSON 同结构，供二维码与文件共用。 */
export const S3_CONFIG_KIND = "git-keymaster-s3";

export function encodeS3ConfigPayload(config: S3Config): string {
  return JSON.stringify({
    kind: S3_CONFIG_KIND,
    version: 1,
    config: {
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      prefix: config.prefix,
    },
  });
}

function pickLocalJsonText(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await file.text());
      } catch (e) {
        reject(e);
      }
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** 桌面走原生路径读取；手机走 `<input type=file>`，避免 content URI 让 `std::fs` 读失败。 */
export async function importS3ConfigFromPicker(): Promise<S3Config | null> {
  if (isMobilePlatform()) {
    const raw = await pickLocalJsonText();
    if (raw == null) return null;
    return api.importS3ConfigText(raw);
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: "导入 S3/R2 配置文件",
    filters: [{ name: "GAM S3/R2 配置", extensions: ["json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  return api.importS3Config(selected);
}
