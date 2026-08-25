/*
 * dragfix —— DeepCode 安装器卡片的拖动支持（P8-D40）。
 *
 * 深海卡片是无标题栏窗口，Win32 只有命中标题栏（HTCAPTION）才给系统拖动。
 * 纯 NSIS 脚本挂不了窗口过程，所以用这个 ~30 行的微型插件：子类化安装器
 * 顶层窗，把客户区命中一律上报为 HTCAPTION——卡片上没有任何需要点击的
 * 控件（图 + 进度条，零交互），整窗即把手。系统 hit-test 先问顶层，
 * 返回 HTCAPTION 后不再下发子窗，进度条照常绘制不受影响。
 *
 * 构建（zig 免装工具链，产 32 位 DLL 配 NSIS x86-unicode 插件槽）：
 *   zig cc -target x86-windows-gnu -shared -O2 -s \
 *     -o build/x86-unicode/dragfix.dll apps/desktop/installer-plugin/dragfix.c \
 *     -lcomctl32 -luser32
 * 产物提交进仓库（build/x86-unicode/dragfix.dll）：构建机默认没有 C 工具链，
 * 打包流程不重编它；改本文件后需手动重编并一并提交。
 *
 * NSIS 侧调用（页面 SHOW 钩子，UI 线程）：
 *   dragfix::Enable
 * 导出遵循 NSIS 插件惯例（cdecl、五参数），本插件不读栈参数。
 */
#include <windows.h>
#include <commctrl.h>

static LRESULT CALLBACK DragProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp,
                                 UINT_PTR id, DWORD_PTR ref) {
  if (msg == WM_NCHITTEST) {
    LRESULT hit = DefSubclassProc(hwnd, msg, wp, lp);
    if (hit == HTCLIENT) return HTCAPTION;
    return hit;
  }
  return DefSubclassProc(hwnd, msg, wp, lp);
}

__declspec(dllexport) void Enable(HWND hwndParent, int string_size,
                                  wchar_t *variables, void *stacktop,
                                  void *extra) {
  (void)string_size; (void)variables; (void)stacktop; (void)extra;
  if (hwndParent != NULL) {
    SetWindowSubclass(hwndParent, DragProc, 1, 0);
  }
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
  (void)inst; (void)reason; (void)reserved;
  return TRUE;
}
