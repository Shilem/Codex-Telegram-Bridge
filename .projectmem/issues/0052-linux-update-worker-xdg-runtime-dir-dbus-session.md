# #0052 Linux /update worker 未继承 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，安装完成后 systemctl --user restart 无法连接 user bus，导致更新失败。VPS journal 已复现：Failed to connect to user scope bus。

- 2026-08-22T04:58:02Z `issue`: Linux /update worker 未继承 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，安装完成后 systemctl --user restart 无法连接 user bus，导致更新失败。VPS journal 已复现：Failed to connect to user scope bus。 [src/update/manager.ts:#workerEnvironment]
- 2026-08-22T05:00:04Z `attempt`: 修复 #0052：更新 worker 白名单继承 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS；VPS systemd --user 可连接 user bus，回归测试覆盖并通过完整校验。 [src/update/manager.ts:#workerEnvironment] (worked)
- 2026-08-22T05:00:04Z `fix`: #0052 已修复：Linux /update 独立 worker 保留 user systemd bus 环境，安装后可安全重启服务。 [79 项测试、审计与分发测试通过]
