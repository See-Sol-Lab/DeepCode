// DeepCode 设置分区的 Host 面：故意什么都不做（与皮肤同则）。
//
// 全部作用发生在浏览器侧（settings.section 注册 + 回环控制桥调用），
// Host 侧没有要注册的服务、路由或设置。保留这个入口只因 Cordis 会加载
// 包的主入口——一个空的 apply 比让加载器去猜要诚实。
export function apply() {}
