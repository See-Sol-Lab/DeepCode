// DeepSeekGUI 皮肤的 Host 面：故意什么都不做。
//
// 全部作用发生在浏览器侧（token 覆盖层），Host 侧没有要注册的服务、路由或
// 设置。保留这个入口只因 Cordis 会加载包的主入口——一个空的 apply 比让
// 加载器去猜要诚实。
//
// 主题偏好由官方 ui-theme 持有；DeepSeekGUI 的 Electron 宿主直接读同一份
// settings 文档同步自己的顶栏与背景图，不经过这里。
export function apply() {}
