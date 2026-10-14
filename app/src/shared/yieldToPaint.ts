/** 让出两帧，让已经提交的界面先画出来，再开始解密或大批 IPC。 */
export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}
