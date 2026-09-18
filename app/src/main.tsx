import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/i18n'
import App from './App.tsx'
import { LocaleProvider } from './lib/locale'
import { isAndroid, isIOS, resolvePlatform } from './platform/resolve'

/**
 * 启动引导：先把平台写进 <html data-platform>，样式据此分流；
 * 移动端才动态加载 mobile.css（桌面产物运行时永不加载它，物理隔离）。
 * 首帧前 await 掉移动样式，避免出现桌面→移动的闪烁。
 */
async function bootstrap() {
  const platform = resolvePlatform()
  document.documentElement.dataset.platform = platform
  document.documentElement.dataset.os = isIOS() ? 'ios' : isAndroid() ? 'android' : 'desktop'
  if (platform === 'mobile') {
    await import('./styles/mobile.css')
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </StrictMode>,
  )
}

void bootstrap()
