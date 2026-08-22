# #0048 Linux 重启 worker 的环境白名单未传递 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，systemctl --user restart 可能无法连接 user systemd bus。

- 2026-08-22T03:26:21Z `issue`: Linux 重启 worker 的环境白名单未传递 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，systemctl --user restart 可能无法连接 user systemd bus。 [src/update/restart-manager.ts:184]
- 2026-08-22T03:38:57Z `attempt`: 修复 #0048：restart worker 继承受控 XDG_RUNTIME_DIR 与 DBUS_SESSION_BUS_ADDRESS，并由测试验证 Linux user systemd 环境。 [实现验证] (worked)
- 2026-08-22T03:38:58Z `fix`: #0048 已修复：Linux user systemd 需要的受控会话环境已传递给重启 worker。 [完整测试与分发校验通过]
