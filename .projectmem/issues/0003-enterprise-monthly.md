# #0003 历史问题：Enterprise 的 Monthly 额度未显示

- 2026-08-14T10:47:57Z `issue`: 历史问题：Enterprise 的 Monthly 额度未显示 [BUG_LOG.md]
- 2026-08-14T10:47:57Z `attempt`: 历史根因：`/quota` 只读取 `account/rateLimits/read` 并渲染 `primary/secondary` 时间窗口，没有先通过 `account/read` 判断账户类型，也忽略了企业主额度桶里的 `individualLimit`。Business/Enterprise 登录因此只能看到“工作区点数可用”，看不到月度剩余比例、已用点数和重置时间。 [BUG_LOG.md] (worked)
- 2026-08-14T10:47:57Z `fix`: 历史修复：先读取账户类型并映射 ChatGPT 套餐；Business、Enterprise、Education 等企业套餐把 `individualLimit` 展示为月度额度，同时保留模型专属的五小时和每周窗口。API Key 与 Amazon Bedrock 不再调用只适用于 ChatGPT 的额度接口，而是明确提示到对应平台查询。额度上限、已用值、剩余比例和重置时间全部使用 App Server 原值，不做本地估算。；验证：单元测试覆盖 ChatGPT Pro、Enterprise Monthly、API Key、空额度桶和缺少窗口字段；本机 Codex 0.147.0 的脱敏合约验证识别 `business` 为 Enterprise，并展示 35,000 点月额度、剩余比例和月初重置时间，未输出邮箱。 [BUG_LOG.md]
- 2026-08-14T10:52:37Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
