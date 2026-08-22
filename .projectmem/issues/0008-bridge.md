# #0008 历史问题：Bridge 内执行发布测试时配置夹具被宿主环境覆盖

- 2026-08-14T10:47:59Z `issue`: 历史问题：Bridge 内执行发布测试时配置夹具被宿主环境覆盖 [BUG_LOG.md]
- 2026-08-14T10:48:00Z `attempt`: 历史根因：通过已安装 Bridge 启动的 Codex 会继承宿主服务的 `CTB_CONFIG_FILE`；发布测试只覆盖 `CTB_CONFIG_DIR`，安装器因此继续使用宿主配置路径，测试夹具内缺少预期的 `config.json`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:00Z `fix`: 历史修复：发布测试显式把 `CTB_CONFIG_FILE` 绑定到临时夹具，确保不读取或写入宿主服务配置。；验证：在带宿主 `CTB_CONFIG_FILE` 的 Bridge 会话中运行 `test/distribution/test_distribution.sh`，安装、签名更新、篡改拒绝和回滚全部通过。 [BUG_LOG.md]
- 2026-08-14T10:52:38Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
