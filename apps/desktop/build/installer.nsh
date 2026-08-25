# DeepCode 的 NSIS 自定义片段（P8-D4 / P8-D21 / P8-D31）。
# electron-builder 经 electron-builder.yml 的 nsis.include 把本文件 !include
# 进它生成的安装脚本（拼在最终脚本最前部）。
#
# ⚠ 本文件必须保存为**带 BOM 的 UTF-8**：NSIS 3 在没有 BOM 时按系统 ANSI
#   （中文 Windows 是 CP936）解析源文件，中文文案会整段变成乱码。
#
# ── P8-D31 深海卡片安装皮肤 ──
# 目标视觉对齐 DS 官网招聘卡片：整窗深蓝海流底图（Sol 供图）＋白色加粗大字
# ＋圆角窗体＋底部细进度条。
#
# 这套方案的每一步都是被失败逼出来的，改动前先读省一晚上：
# ① oneClick 用户看到的从来不是 MUI 主窗——installSection.nsh 在 section 开头调
#   SpiderBanner::Show，主窗被藏，露脸的是 banner 小窗。装修主窗没有意义。
# ② banner 出现在一切页面钩子之后，且 MUI 页面上 nsDialogs 的 NSD_CreateTimer
#   根本不触发（实测 arm 后零 tick）、StdUtils 插件在本文件编译点尚未
#   !addplugindir（Plugin not found）、GUIINIT 里挂 timer 直接闪退。
#   **时机问题的正解是给模板一个 hook**：pnpm patch（patches/
#   app-builder-lib@26.15.3.patch）在 SpiderBanner::Show 之后插了一行可选宏
#   customSpiderBannerShown——banner 刚建好、每次必到、无竞态。
# ③ hook 跑在 section 线程：**不能 CreateWindowEx**（新窗附着到不泵消息的
#   section 线程，永不重绘），文字也没法用 SetCtlColors 上色（banner 的窗口
#   过程是插件的，NSIS 着色表管不到）。所以文字直接烙进 BMP（生成图时用
#   System.Drawing 画的，抗锯齿比 GDI 控件还好），背景用**类背景刷**
#   （LoadImage 按窗口尺寸缩放加载 → CreatePatternBrush → SetClassLong
#   GCLP_HBRBACKGROUND）——重绘由系统完成，一个新窗口都不用建。
#   进度条是唯一搬动的既有控件：SetParent 到 banner（HWND 不变，NSIS 的进度
#   消息照发），跨线程窗口操作是 Win32 允许的。

!include "LogicLib.nsh"

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    # 卸载页面（皮肤卡片）完成后自动关窗——不留一个要点「关闭」的尾巴，
    # 与安装侧的一键体感对齐。安装器的关闭行为由模板管，这里不碰。
    AutoCloseWindow true
  !endif
  # P8-D4(a)：NSIS 默认不声明 DPI 感知，界面按 96 DPI 渲染再拉伸到高分屏，
  # 字因此发虚。electron-builder 26 没暴露开关；customHeader 展开在
  # installer.nsi 文件顶层，正是编译期属性指令的合法位置。
  ManifestDPIAware true
!macroend

# ── P8-D31 深海卡片安装皮肤（Sol 复核后的终版路线，2026-08-23）──
# 视觉：整窗深蓝海流底图（Sol 供图，「DeepCode／正在安装…」两行字已在生成
# 图时烙入，抗锯齿）＋圆角无边框卡片＋底部细进度条。
#
# 路线（候选 D，Sol 拍板）：**不创建 SpiderBanner，让 MUI InstFiles 主窗直接
# 露脸**。pnpm patch（patches/app-builder-lib@26.15.3.patch）给模板加了编译期
# 开关——定义 DEEPCODE_USE_MUI_INSTFILES 时 installSection 跳过
# SpiderBanner::Show，改为 ShowWindow $HWNDPARENT。主窗上的皮肤钩子
# （MUI_PAGE_CUSTOMFUNCTION_SHOW，UI 线程，2026-08-23 4:58 版日志全程验证过）
# 因此画在用户真正看到的窗口上。oneClick/per-user/自动启动/静默升级全不受影响。
#
# 历史教训（详见 git 历史与 D31 交接文档）：装修 SpiderBanner 的三轮尝试
# 全部失败——banner 属插件线程，页面钩子够不着、nsDialogs timer 在 MUI 页
# 不触发、section 线程改不动它也画不上图。别再走回头路。

!define DEEPCODE_USE_MUI_INSTFILES

# ── 皮肤本体(安装/卸载共用;BGPREFIX 选带对应文案的底图) ──
!macro DEEPCODE_SKIN_BODY BGPREFIX
  # 系统 DPI → 缩放百分比（ManifestDPIAware true 下坐标即物理像素）
  System::Call 'user32::GetDpiForSystem() i .r2'
  ${if} $2 <= 0
    StrCpy $2 96
  ${endif}
  IntOp $2 $2 * 100
  IntOp $2 $2 / 96

  # 底图（文字已烙入）按 DPI 选**精确尺寸**的一档，1:1 显示零缩放——
  # 静态控件的 REALSIZECONTROL 缩放是低质量 StretchBlt，一张大图缩下来
  # 文字全是锯齿（住户 2026-08-23 报）。四档在生成时就按目标分辨率渲染、
  # 字体直接以最终大小画，锐利。非常规 DPI 落到最近一档，轻微缩放可接受。
  InitPluginsDir
  ${if} $2 >= 200
    File "/oname=$PLUGINSDIR\deepcode-bg.bmp" "${PROJECT_DIR}\apps\desktop\build\${BGPREFIX}-bg-200.bmp"
  ${elseif} $2 >= 150
    File "/oname=$PLUGINSDIR\deepcode-bg.bmp" "${PROJECT_DIR}\apps\desktop\build\${BGPREFIX}-bg-150.bmp"
  ${elseif} $2 >= 125
    File "/oname=$PLUGINSDIR\deepcode-bg.bmp" "${PROJECT_DIR}\apps\desktop\build\${BGPREFIX}-bg-125.bmp"
  ${else}
    File "/oname=$PLUGINSDIR\deepcode-bg.bmp" "${PROJECT_DIR}\apps\desktop\build\${BGPREFIX}-bg-100.bmp"
  ${endif}

  # 卡片尺寸 360×270（与底图 4:3 一致；住户 2026-08-23 定：初版 720 太大，缩半）× DPI
  IntOp $7 360 * $2
  IntOp $7 $7 / 100
  IntOp $8 270 * $2
  IntOp $8 $8 / 100

  # 外窗：去标题栏与边框成纯卡片（WS_CAPTION 0xC00000 | WS_THICKFRAME 0x40000）。
  # 拖动暂缺（P8-D40 dragfix 已摘除做 D43 对照，见宏尾注释；「装几十秒不
  # 需要拖」被住户实测证伪，拖动需求仍在、等不常驻的新实现）；关闭按钮
  # 仍然不给——一键流程。
  System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -16) i .r3'
  IntOp $3 $3 & 0xFF33FFFF
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -16, i r3)'

  # 居中 + 定尺寸（0x20 = SWP_FRAMECHANGED，让去边框立即生效）
  System::Call 'user32::GetSystemMetrics(i 0) i .r3'
  System::Call 'user32::GetSystemMetrics(i 1) i .r4'
  IntOp $3 $3 - $7
  IntOp $3 $3 / 2
  IntOp $4 $4 - $8
  IntOp $4 $4 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r3, i r4, i r7, i r8, i 0x20)'

  # 圆角（直径 ≈ 18 逻辑像素 ×2）
  IntOp $3 24 * $2
  IntOp $3 $3 / 100
  System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i r7, i r8, i r3, i r3) p .r4'
  System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p r4, i 1)'

  # 外窗旧家具全部收起（实测内页置顶盖不全）：header 图标/标题/副标题/
  # 背景条（1034-1039、1046）、branding 「DeepCode 1.0.0」与分隔线（1256、
  # 1028、1035/1036）、底部「关闭/取消/上一步」按钮（1/2/3）。藏空 id 无害。
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1034
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1036
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1045
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1046
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0

  # 内页拉满整个窗口并置顶。防御：拿不到内页就放弃皮肤，绝不挡安装。
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${if} $1 P= 0
    Return
  ${endif}
  System::Call 'user32::SetWindowPos(p r1, p 0, i 0, i 0, i r7, i r8, i 0x0)'

  # 内页旧家具：状态文本、详情、日志、可能的小图标全部隐藏
  GetDlgItem $0 $1 1006
  ShowWindow $0 0
  GetDlgItem $0 $1 1016
  ShowWindow $0 0
  GetDlgItem $0 $1 1027
  ShowWindow $0 0
  GetDlgItem $0 $1 1030
  ShowWindow $0 0
  GetDlgItem $0 $1 1031
  ShowWindow $0 0

  # 底图铺满内页：SS_BITMAP(0xE)|SS_REALSIZECONTROL(0x40)|WS_CHILD|WS_VISIBLE，
  # 压到 Z 序最底，进度条浮在图上。SHOW 在 UI 线程，建子窗合法（4:58 版实证）。
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x5000004E, i 0, i 0, i r7, i r8, p r1, i 0, p 0, p 0) p .r3'
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\deepcode-bg.bmp", i 0, i 0, i 0, i 0x10) p .r6'
  SendMessage $3 0x0172 0 $6 ; STM_SETIMAGE(IMAGE_BITMAP)
  System::Call 'user32::SetWindowPos(p r3, p 1, i 0, i 0, i 0, i 0, i 0x3)' ; HWND_BOTTOM

  # 进度条（1004）：摆到卡片底部做细横条。去视觉主题后 PBM 自定义色才生效；
  # 底色深海、条色取图里的亮蓝。
  GetDlgItem $0 $1 1004
  ${if} $0 P<> 0
    IntOp $3 24 * $2
    IntOp $3 $3 / 100
    IntOp $4 246 * $2
    IntOp $4 $4 / 100
    IntOp $R7 312 * $2
    IntOp $R7 $R7 / 100
    IntOp $R8 4 * $2
    IntOp $R8 $R8 / 100
    System::Call 'user32::SetWindowPos(p r0, p 0, i r3, i r4, i R7, i R8, i 0x40)' ; SWP_SHOWWINDOW
    System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
    SendMessage $0 0x2001 0 0x2A1A0F ; PBM_SETBKCOLOR 深海底(BGR)
    SendMessage $0 0x0409 0 0xE6BE78 ; PBM_SETBARCOLOR 亮蓝(BGR)
  ${endif}

  # 整窗可拖（P8-D40）——**已摘除**（2026-08-23 对照实验，下一包验证）：
  # 自研 dragfix 微插件（源码 apps/desktop/installer-plugin/dragfix.c）两轮
  # 实测净贡献为负——拖动始终未生效（住户拽不动），且 /NOUNLOAD 让子类
  # 过程常驻安装器窗，强嫌疑拖住 NSIS 收尾（P8-D43：满进度卡 2-3 分钟）。
  # 摘除即对照组：下一包若尾段卡顿消失则 D43 坐实由它引起；拖动需求另找
  # 不常驻的实现（如 WM_LBUTTONDOWN 转 SC_MOVE），别再走窗口子类化。
  # 旧调用与 /NOUNLOAD 的教训留档：
  #   dragfix::Enable /NOUNLOAD   # NSIS 调完即 FreeLibrary，子类过程常驻
  #   窗口，DLL 一卸下一条 WM_NCHITTEST 跳进已释放内存，安装器无声崩死
  #   （2026-08-23 实机：dragfix.dll_unloaded 0xc0000005）。
!macroend

!ifndef BUILD_UNINSTALLER
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW deepcodeSkinShow
  Function deepcodeSkinShow
    !insertmacro DEEPCODE_SKIN_BODY "installer"
  FunctionEnd
!else
  # 卸载器没有 SpiderBanner,MUI 主窗直接可见,同一套皮肤直接适用。
  # SHOW define 不能写在顶层——卸载器编译里安装页(oneClick.nsh 顶层裸放)
  # 先展开、会把 un. 函数吃进永不显示的安装页并编译报错。patch 在两个页面
  # 之间开了 customUnpageInstfilesPre seam,define 在安装页展开之后落地。
  !macro customUnpageInstfilesPre
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.deepcodeSkinShow
  !macroend
  Function un.deepcodeSkinShow
    !insertmacro DEEPCODE_SKIN_BODY "uninstaller"
  FunctionEnd
!endif

!macro customUnInstall
  # P8-D21：卸载器从来没有交代过用户数据留在哪儿。这里问一次，默认保留。
  #
  # 时机说明（这段是本宏唯一的复杂之处，别照直觉改）：一键卸载器在 un.onInit 里
  # 弹完「确定要卸载吗」之后会立刻 SetSilent silent（模板 uninstaller.nsh），而本宏
  # 在那之后才执行——所以此处 ${Silent} 恒为真，用它判断用户意图必然出错，只能看
  # 命令行。真正的静默卸载都带 /S：升级走
  # `ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA ...'`（installUtil.nsh），
  # 系统的 QuietUninstallString 也是 `"$2" $0 /S`（installer.nsh）。因此 /S 就是
  # 「别打扰用户」的可靠信号，而它的缺席就是「人正坐在屏幕前」。
  #
  # MessageBox 这里故意不写 /SD：带 /SD 时静默模式会自动应答而不显示，正是我们要
  # 避免的——用户点开卸载之后必须真的看见这一问。
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/S" $R1
  ${if} ${Errors}
    # D29 追加（住户 2026-08-23）：卡片/弹窗中英同屏——安装器没有语言切换，
    # 中文在前英文在后，两边用户都能看懂。
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 DeepCode 的数据目录？$\r$\n其中包含 Harness 主目录、会话记录、日志与缓存：$\r$\n$APPDATA\${APP_FILENAME}$\r$\n选「否」会保留这些数据，重新安装后可以接着用。$\r$\n$\r$\nAlso delete DeepCode's data folder (Harness home, sessions, logs, caches)?$\r$\nChoose No to keep the data for a future reinstall." IDNO deepcodeKeepAppData
      # Electron 的用户数据一律落在当前用户名下，即使程序本身装成 per-machine，
      # 所以删之前把 shell 变量上下文切回 current（与模板同一处理）。
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$APPDATA\${APP_FILENAME}"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    deepcodeKeepAppData:
  ${endif}
!macroend
