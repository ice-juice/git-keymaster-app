import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { displayNameFor, isEnglishLang } from '../scripts/brand.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const raw = String(env.VITE_APP_LANG || "zh").trim().toLowerCase()
  const lang = isEnglishLang(raw) ? "en" : "zh"
  const displayName = displayNameFor(lang)

  return {
    plugins: [react(), tailwindcss()],
    envDir: process.cwd(),
    define: {
      "import.meta.env.VITE_APP_LANG": JSON.stringify(lang),
      "import.meta.env.VITE_APP_NAME": JSON.stringify(displayName),
    },
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      // 安卓/iOS 调试时 Tauri CLI 会注入局域网 IP；桌面端未设置则仍只绑 localhost
      host: process.env.TAURI_DEV_HOST || false,
      hmr: process.env.TAURI_DEV_HOST
        ? { protocol: "ws", host: process.env.TAURI_DEV_HOST, port: 5174 }
        : undefined,
      fs: {
        allow: ['..'],
      },
      watch: {
        // Cargo 编译时会锁 target 下的 dll；Vite 监听这些文件会在 Windows 上 EBUSY 崩溃
        ignored: ['**/src-tauri/**'],
      },
    },
  }
})
