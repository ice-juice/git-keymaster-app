/**
 * 从环境变量写出 gen/android/keystore.properties，并把 Base64 钥匙解码到临时文件。
 * 不打印口令或钥匙内容。
 *
 * 需要：ANDROID_KEY_BASE64、ANDROID_KEY_ALIAS、ANDROID_KEY_PASSWORD
 * 可选：ANDROID_KEYSTORE_PATH（默认 $RUNNER_TEMP/upload-keystore.jks 或系统临时目录）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return value;
}

export function writeAndroidSigningFiles({
  alias = process.env.ANDROID_KEY_ALIAS,
  password = process.env.ANDROID_KEY_PASSWORD,
  base64 = process.env.ANDROID_KEY_BASE64,
  storePath = process.env.ANDROID_KEYSTORE_PATH,
  projectRoot = rootDir,
} = {}) {
  if (!alias || !password || !base64) {
    throw new Error("需要 ANDROID_KEY_ALIAS、ANDROID_KEY_PASSWORD、ANDROID_KEY_BASE64");
  }
  const dest = storePath
    || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "upload-keystore.jks");
  const bytes = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  if (bytes.length < 32) {
    throw new Error("ANDROID_KEY_BASE64 解码后过短，钥匙可能没贴完整");
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  const propsPath = path.join(projectRoot, "app", "src-tauri", "gen", "android", "keystore.properties");
  fs.mkdirSync(path.dirname(propsPath), { recursive: true });
  const storeFile = dest.replace(/\\/g, "/");
  fs.writeFileSync(
    propsPath,
    `keyAlias=${alias}\npassword=${password}\nstoreFile=${storeFile}\n`,
    "utf8",
  );
  return { propsPath, storeFile, storeBytes: bytes.length };
}

const invoked = process.argv[1] && path.basename(process.argv[1]) === "setup-android-signing.mjs";
if (invoked) {
  try {
    if (process.argv[2] === "--test") {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "android-signing-"));
      const fake = Buffer.alloc(64, 7);
      const written = writeAndroidSigningFiles({
        alias: "upload",
        password: "not-a-real-password",
        base64: fake.toString("base64"),
        storePath: path.join(tmp, "upload-keystore.jks"),
        projectRoot: tmp,
      });
      const text = fs.readFileSync(written.propsPath, "utf8");
      if (!text.includes("keyAlias=upload") || !text.includes("storeFile=")) {
        throw new Error("keystore.properties 内容不对");
      }
      if (fs.statSync(written.storeFile).size !== 64) {
        throw new Error("解码后的钥匙长度不对");
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log("[android-signing] self-test ok");
    } else {
      requiredEnv("ANDROID_KEY_ALIAS");
      requiredEnv("ANDROID_KEY_PASSWORD");
      requiredEnv("ANDROID_KEY_BASE64");
      const written = writeAndroidSigningFiles();
      console.log(`[android-signing] wrote keystore.properties storeBytes=${written.storeBytes}`);
    }
  } catch (err) {
    console.error(`[android-signing] ${err.message}`);
    process.exit(1);
  }
}
