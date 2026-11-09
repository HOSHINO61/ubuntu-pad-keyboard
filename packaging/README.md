# 打包说明：pad-osk

屏幕键盘的 Debian 包。源码在 `scripts/`，包定义为 `packaging/pad-osk/`，
产物在 `dist/`。

---

## 为什么是 `.deb` 而不是别的形式

这套东西天然适合打 deb：

- 扩展、启动器、桌面项都是**系统级安装**的文件，没有构建步骤
- `dpkg` 负责文件权属、卸载、升级，比手工 `cp` 干净
- **不需要 debhelper**，`dpkg-deb` 一个工具就够（避免引入构建依赖）

**不用 `gnome-extensions pack`**：那只产出一个 zip，用户还得自己
`gnome-extensions install`，而且装不到系统目录、也没有卸载记录。

---

## 构建

在 Linux 主机上，从项目根目录：

```bash
sh packaging/build-deb.sh
```

产物：`dist/pad-osk_<版本>_<架构>.deb`

脚本做的事：

1. 从 `DEBIAN/control` 读版本号与架构
2. 把 `scripts/` 里的源文件复制进 `packaging/pad-osk/usr/`：

   | 源 | 目标 |
   |---|---|
   | `scripts/pad-osk-ext/extension.js`、`metadata.json` | `/usr/share/gnome-shell/extensions/pad-osk@local/` |
   | `scripts/pad-osk-toggle.sh` | `/usr/bin/pad-osk` |
   | `scripts/pad-osk.desktop` | `/usr/share/applications/` |

3. 显式 `chmod`（`dpkg-deb` 会保留目录树的权限位）
4. 把 `postinst` 里的 `@VERSION@` 替换为真实版本
5. `dpkg-deb --build --root-owner-group`

> `--root-owner-group` 很重要：否则包内文件属主会是你当前的 uid，
> 安装后变成奇怪的属主而不是 `root`。

---

## 安装 / 卸载

```bash
sudo apt install ./dist/pad-osk_0.Beta_arm64.deb
sudo apt remove  pad-osk
sudo apt purge   pad-osk
```

⚠️ **如果机器上装过 `1.0.0`（旧命名），升级到 `1.0` 会被当成"降级"**：

```bash
$ dpkg --compare-versions 1.0 gt 1.0.0; echo $?     # → 非 0，即 1.0 <= 1.0.0
E: 降级软件包同时使用了 -y 选项，但是没有用 --allow-downgrades.
```

dpkg 的版本比较是**分段**的，`1.0` 比 `1.0.0` 旧。首次从旧的 `all` 包迁移时用：

```bash
sudo apt install -y --allow-downgrades ./dist/pad-osk_0.Beta_arm64.deb
```

之后同版本重装、或升到 `1.0.1` 都不再需要这个开关。

装完**需要注销重新登录一次**——GNOME 只在 shell 启动时扫描扩展目录。

---

## 命名约定

`pad-osk_<版本>_<架构>.deb`，版本与架构都直接来自 `DEBIAN/control`，
改 `control` 就同时改了文件名和包内字段，两者不会脱节。

当前为 `1.0` + `arm64`。注意 `Architecture: arm64` 会让 dpkg **拒绝在 x86
等其它架构上安装**——包内其实没有架构相关文件（纯 JS + shell 脚本），
如果希望哪都能装，把 `control` 里改回 `all` 即可（文件名也随之变成 `_all`）。

---

## 打包时处理的三个坑

### 1. 同名 UUID 的手工安装副本会抢先

设备上原本是手工装的（`~/.local/share/gnome-shell/extensions/pad-osk@local`）。
包装到系统级目录后，**同 uuid 两份共存**，shell 会挑其中一份，
很可能还是旧的——于是"装了新版却毫无变化"。

`postinst` 的处理：把用户级副本**改名**为 `pad-osk@local.hand-installed`
而不是删除（用户可能想回溯），然后清掉会遮蔽包内文件的
`/usr/local/bin/pad-osk` 和 `~/.local/share/applications/pad-osk.desktop`。

### 2. 桌面项的 `Exec=` 不能写死路径

原先是 `Exec=/usr/local/bin/pad-osk`。改成 deb 后启动器在 `/usr/bin`，
按 Debian 惯例应当**不带路径**、依赖 `PATH`：

```ini
Exec=pad-osk
```

### 3. 卸载不要碰用户数据

`~/.config/pad-osk/` 存的是键盘位置（`position.kf`）和开关状态（`visible`）。
`postrm` **故意不删**：重装后位置和开关状态还在，符合预期。
同理也不去改用户的 `enabled-extensions` 列表——目录没了 shell 自己会忽略该 uuid。

---

## 验证记录（2026-10-26，实机）

```
构建      pad-osk_0.Beta_arm64.deb（15,118 字节）
安装      dpkg -l → ii  pad-osk 0.Beta arm64
字段      Version: 0.Beta    Architecture: arm64   （与文件名一致）
文件      /usr/bin/pad-osk, /usr/share/applications/…,
          /usr/share/gnome-shell/extensions/pad-osk@local/{extension.js,metadata.json}
手抄本    已移到 pad-osk@local.hand-installed
旧启动器  /usr/local/bin/pad-osk 已移除
旧桌面项  ~/.local/share/applications/… 已移除
启动器    pad-osk → keyboard on / keyboard off（往返正常）
卸载      系统目录与启动器清空，~/.config/pad-osk/ 保留
重装      回到 ii 状态
```

---

## 验证记录（2026-11-03，1.0，构建机 + 实机）

1.0 加了 ⚙ 设置面板（尺寸 / 配色 / 透明 / 圆角）、自定义配色、背景图与恢复默认。
本版在平板上实装验证过：设置面板开合、四套配色切换、透明度 50%–100%、圆角四档、
系统文件选择器选图与导入、`管理…` 删除二次确认、`恢复默认` 保留背景路径，均正常，
`journalctl` 无 JS 异常。

```
构建      pad-osk_1.0_arm64.deb（26,104 字节）
          在 Ubuntu 24.04 x86_64 虚拟机上用 dpkg-deb 1.22.6 构建（纯打包，无编译）
sha256    26bc5b3a4878a8c3373cddb5f1bcfbda02db0c007e4c4b0313a77ffb913d1c9d
字段      Package: pad-osk  Version: 1.0  Architecture: arm64
包内      control.tar.zst + data.tar.zst（dpkg ≥ 1.21.18 可解，Ubuntu 22.04+ 都行）
载荷      extension.js / metadata.json / pad-osk / pad-osk.desktop
          与工作区文件 sha256 逐一相同
权限      /usr/bin/pad-osk 0755，其余 0644
换行      四个脚本与配置 CR=0（无 CRLF）
配置目录  ~/.config/pad-osk/（从 ~/.config/erhai-osk/ 一次性迁移）
```

⚠️ `Version:` 已经是 `1.0`。从 `0.Beta` / `0.Beta2` 装上去属于升级；反向回退需要
`apt install --allow-downgrades`。

---

## 验证记录（2026-11-08，1.0.1，构建机）

1.0.1 换掉两件事：`Architecture: all`（一包通吃 arm64/amd64）与界面翻译。

```
构建      pad-osk_1.0.1_all.deb（29,252 字节）
          在 Ubuntu 24.04 x86_64 虚拟机上用 dpkg-deb 1.22.6 + msgfmt 0.21 构建
sha256    0aed11e186af5862da4f1dfe478a0422052ea71679123c39f04159fec1db6fef
字段      Package: pad-osk  Version: 1.0.1  Architecture: all
包内      control.tar.zst + data.tar.zst
载荷      extension.js / metadata.json / pad-osk / pad-osk.desktop
          locale/zh_CN/LC_MESSAGES/pad-osk@local.mo（1,380 字节）
          extension.js / metadata.json / pad-osk 与工作区 sha256 逐一相同
权限      脚本 0755，其余 0644（含 .mo）
翻译      msgunfmt 回读 27 条 msgid，中文 msgstr 完整
```

⚠️ 从 `1.0 arm64` 升到 `1.0.1 all` 是正常升级（dpkg 允许具体架构变 all）；
反向回退仍需 `--allow-downgrades`。

**构建依赖**：`dpkg-deb` 与 `msgfmt`（`apt install gettext`）。缺 `msgfmt` 时
`build-deb.sh` 会直接报错退出，不会静默打出没有翻译的包。

---

## 改版本号

改 `packaging/pad-osk/DEBIAN/control` 里的 `Version:`（和需要时的
`Architecture:`），重新构建即可。`postinst` 里的版本是构建时替换的，不要手写。

---

## 已知限制

- `Architecture: all`：包内是纯 JS + shell 脚本 + `.mo` 翻译，arm64 / amd64 通用
- 构建需要 `dpkg-deb` 和 `msgfmt`（gettext）；`po/*.po` 由 `build-deb.sh` 编译成
  `locale/<lang>/LC_MESSAGES/pad-osk@local.mo`
- 依赖 `gnome-shell (>= 45, << 60)`：扩展用了 GNOME 45+ 的 ESM 扩展 API
  和 `Clutter.VirtualInputDevice`
- 只在 **GNOME 50.1 / Ubuntu 26.04.1 / arm64** 上实测过
- GDM 登录界面**不会**有屏幕键盘（greeter 是独立用户，看不到这个扩展）；
  若要在登录界面输入，只能靠实体键盘或启用自动登录
