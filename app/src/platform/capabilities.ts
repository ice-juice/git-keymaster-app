import { resolvePlatform, type Platform } from "./resolve";

/**
 * 能力矩阵：某个终端「有没有」某项能力。
 *
 * 与「布局」彻底分开——布局回答“长什么样”，能力回答“能不能做”。
 * 页面用能力来决定是否渲染入口，和后端 `AppError::Unsupported`
 * （code `UNSUPPORTED_PLATFORM`）里外呼应。
 *
 * 加一个新能力只改这一处；加一个新终端只在这张表里补一列。
 */
export interface Capabilities {
  /** 本机 Git / SSH 工具链（ssh-agent、~/.ssh/config、git 可执行文件）。 */
  localGitTools: boolean;
  /** 自绘窗口控制按钮（最小化 / 最大化 / 关闭）。 */
  windowControls: boolean;
  /** 屏幕截图取二维码（桌面才有意义，手机用相机）。 */
  screenQrScan: boolean;
  /** 相机扫码（移动端专属）。 */
  cameraQrScan: boolean;
}

const MATRIX: Record<Platform, Capabilities> = {
  desktop: {
    localGitTools: true,
    windowControls: true,
    screenQrScan: true,
    cameraQrScan: false,
  },
  mobile: {
    localGitTools: false,
    windowControls: false,
    screenQrScan: false,
    cameraQrScan: true,
  },
};

export function capabilities(): Capabilities {
  return MATRIX[resolvePlatform()];
}

export function can<K extends keyof Capabilities>(feature: K): boolean {
  return MATRIX[resolvePlatform()][feature];
}
