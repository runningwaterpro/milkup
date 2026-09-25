# 文件 / 大纲 / 项目侧边栏可见性持久化：竞品研究

- 调查日期：2026-09-25
- 来源访问日期：2026-09-25
- 调查对象：VS Code / Code OSS 1.139.1、Obsidian 当前官方文档、Joplin Desktop 3.7.18
- 目的：为 Milkup 决定“用户关闭或展开侧边栏后，重启应恢复什么状态、状态应存在哪里”提供依据。

## 口径

本文中的“显式启动时展开设置”专指：**每次启动都覆盖上次状态、强制展开的用户设置**。默认展开、恢复工作区、Reset Layout 命令不算该设置。

证据分为三类：

- **官方文档**：产品方公开说明当前行为。
- **一手源码**：产品仓库中直接负责读取、保存或渲染状态的代码。
- **源码推断**：由多处代码共同得出的行为；Obsidian 桌面端闭源，无法对其内部实现作同等强度的源码核验。

## 对比结论

| 软件                   | 显式“启动时展开”设置                                                                                                                                        | 自动记住最后可见状态                                                                                                                                    | 状态作用域                                                                                              | 窗口 / 工作区变化时                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VS Code / Code OSS** | **主侧栏：没有。** 当前设置注册表只提供主侧栏位置；次侧栏另有 `defaultVisibility` / `forceMaximized`，但它们不是文件树侧栏。                                | **是。** 官方文档明确说启动时恢复上次关闭时的 folder、layout 和 opened files。                                                                          | **工作区 / 项目级**，且是本机状态（`StorageScope.WORKSPACE` + `StorageTarget.MACHINE`），不是全局偏好。 | 重新打开同一工作区时恢复该工作区状态；换到另一工作区读取另一工作区状态。`window.restoreWindows` 决定恢复哪些旧窗口；若启动一个没有旧状态的新空窗口，主侧栏默认隐藏。 |
| **Obsidian**           | **未见专用设置。** 当前官方 Settings 文档有 `Show ribbon`，但没有左 / 右侧栏“启动时始终展开”的设置；移动端 / 小平板默认折叠属于设备默认，不是用户启动偏好。 | **是。** 官方说明 `.obsidian/workspace.json` 保存当前 workspace layout；官方论坛 staff 进一步明确它让 vault 以离开时的状态重新打开，其中包括 sidebars。 | **Vault / 项目级**。布局文件位于各 vault 自己的 `.obsidian` 中；全局设置另存在系统目录。                | 切换 vault 会切换到该 vault 自己的布局文件；重开同一 vault 恢复其布局。                                                                                              |
| **Joplin Desktop**     | **否。** 有 `Toggle sidebar` 和 `Reset application layout`，但没有强制启动展开设置。新安装默认布局中 sidebar 可见，这是默认值而不是启动覆盖设置。           | **是。** `Toggle sidebar` 改写 `sideBar.visible`；主窗口把包含 `visible` 的完整布局写入 `ui.layout`，下次优先加载。                                     | **Profile 级、本机应用设置**，不是 notebook / 项目级，也不是所有 profile 共用的全局设置。               | 切换 notebook 不改变布局；切换 profile 会使用该 profile 的布局。主窗口布局会持久化；独立笔记窗口的 layout 是单独的内存状态，新进程没有该状态时回到默认。             |

## 1. VS Code / Code OSS

### 证据

- **官方文档**：Primary Side Bar 包含 Explorer；`Ctrl/Cmd+B` 可切换其可见性。文档还明确写道：“Each time you start VS Code, it opens up in the same state it was in when you last closed it. The folder, layout, and opened files are preserved.”
  来源：[User interface — Basic layout / Window management](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_basic-layout)（访问：2026-09-25）
- **一手源码**：`workbench.action.toggleSidebarVisibility` 调用 `layoutService.setPartHidden(...)`，切换的就是 Primary Side Bar。
  来源：[VS Code 1.139.1 — layoutActions.ts L288-L340](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/actions/layoutActions.ts#L288-L340)（访问：2026-09-25）
- **一手源码**：可见性键为 `sideBar.hidden`，默认值是 `false`（即可见），并明确使用 `StorageScope.WORKSPACE` 和 `StorageTarget.MACHINE`。`StorageScope.WORKSPACE` 的官方源码注释是“scoped to the current workspace”；`MACHINE` 表示本机状态。侧栏位置 `workbench.sideBar.location` 则属于可由用户 / 工作区配置的普通设置；不要把位置设置和可见性状态混为一谈。
  来源：[VS Code 1.139.1 — layout.ts L2898-L2909](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/layout.ts#L2898-L2909)、[storage.ts L228-L262](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/platform/storage/common/storage.ts#L228-L262)（访问：2026-09-25）
- **一手源码**：启动时先从 storage 加载所有布局键；只有没有存储值时才采用动态默认值。非空工作区默认显示主侧栏，空窗口默认隐藏。
  来源：[VS Code 1.139.1 — layout.ts L3002-L3028](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/layout.ts#L3002-L3028)（访问：2026-09-25）
- **一手源码**：Workbench 保存状态时调用 `stateModel.save(true, true)`；`save` 会把 `StorageScope.WORKSPACE` 键写回 storage。
  来源：[VS Code 1.139.1 — layout.ts L1737-L1744](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/layout.ts#L1737-L1744)、[layout.ts L3151-L3165](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/layout.ts#L3151-L3165)（访问：2026-09-25）
- **显式设置核验**：主侧栏在设置注册表中只有 `workbench.sideBar.location`（左 / 右位置）；同一段源码却为次侧栏提供了 `workbench.secondarySideBar.defaultVisibility` 和实验性的 `forceMaximized`。因此不能把次侧栏的启动设置误认为主侧栏也有。
  来源：[VS Code 1.139.1 — workbench.contribution.ts L585-L635](https://github.com/microsoft/vscode/blob/1.139.1/src/vs/workbench/browser/workbench.contribution.ts#L585-L635)（访问：2026-09-25）

### 判定

VS Code 的主侧栏采用“**有工作区状态就恢复；没有才用上下文默认值**”。它没有把“始终展开”做成主侧栏的普通用户设置。次侧栏的 `defaultVisibility` 证明：当产品有明确需求时，增加“只影响首次打开 / 空窗口”的默认策略是可行的，但不必取代普通布局恢复。

## 2. Obsidian

### 证据

- **官方文档**：Obsidian 有左右两个 sidebar，可折叠并重新打开；移动端和较小平板默认折叠。
  来源：[Obsidian Help — Sidebar](https://help.obsidian.md/sidebar)、[固定文档源码 Sidebar.md L10-L24](https://github.com/obsidianmd/obsidian-help/blob/bc5b4f2b4fb1e0c873912fb0a8b769a1a6450f4a/en/User%20interface/Sidebar.md#L10-L24)（访问：2026-09-25）
- **官方文档**：每个 vault 有自己的 `.obsidian` 配置目录；`.obsidian/workspace.json` 和 `.obsidian/workspaces.json` 保存“current workspace layout”。Obsidian 又明确把 vault-specific preferences 与系统目录中的 global settings 分开。
  来源：[Obsidian Help — How Obsidian stores data](https://help.obsidian.md/data-storage)、[固定文档源码 L21-L36](https://github.com/obsidianmd/obsidian-help/blob/bc5b4f2b4fb1e0c873912fb0a8b769a1a6450f4a/en/Files%20and%20folders/How%20Obsidian%20stores%20data.md#L21-L36)（访问：2026-09-25）
- **官方 staff 说明**：Obsidian moderator/staff `ariehen` 明确回复：`workspace.json` “saves your workspace layout so that the vault will reopen in the same state that you left it in”，并列出了 windows、sidebars 等布局内容。
  来源：[Obsidian Forum — What does workspace.json do?（staff 回复）](https://forum.obsidian.md/t/what-does-workspace-json-do/68392/2)（访问：2026-09-25）
- **显式设置核验**：当前官方 Settings 文档的 Appearance / Interface 区域列出 `Show ribbon`、ribbon menu 等设置，但没有左 / 右侧栏“启动时始终展开”项。
  来源：[Obsidian Help — Settings](https://help.obsidian.md/settings#Appearance)、[固定文档源码 Settings.md L304-L320](https://github.com/obsidianmd/obsidian-help/blob/bc5b4f2b4fb1e0c873912fb0a8b769a1a6450f4a/en/User%20interface/Settings.md#L304-L320)（访问：2026-09-25）

### 判定与限制

Obsidian 采用“**每个 vault 自动保存并恢复整个 workspace layout**”，没有发现独立的“启动时展开”偏好。`Show ribbon` 控制 Ribbon，不等于 sidebar 可见性。

桌面应用闭源，因此“官方设置目录中未出现”只能作为当前公开界面的核验，不能证明内部绝不存在隐藏或实验设置；自动恢复本身则由官方文档和 staff 说明直接支持。

## 3. Joplin Desktop

### 证据

- **一手源码**：默认主布局包含 `sideBar` 和 `noteList`，没有把二者设为 `visible: false`；渲染规则把 `visible !== false` 视为可见。因此新安装的默认主窗口布局是展开的。
  来源：[Joplin v3.7.18 — MainScreen.tsx L108-L116](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/MainScreen.tsx#L108-L116)、[resizeLogic.ts L8-L12](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/ResizableLayout/utils/resizeLogic.ts#L8-L12)（访问：2026-09-25）
- **一手源码**：`Toggle sidebar` 反转 `sideBar.visible` 并更新 main layout。
  来源：[Joplin v3.7.18 — toggleSideBar.ts L7-L34](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/WindowCommandsAndDialogs/commands/toggleSideBar.ts#L7-L34)（访问：2026-09-25）
- **一手源码**：`saveLayout` 的白名单明确包含 `visible`；`buildLayout` 优先读取 `ui.layout`，没有用户布局时才使用默认布局；main layout 每次变化都会写回 `ui.layout`。这完整证明了“折叠后重启仍折叠”。
  来源：[Joplin v3.7.18 — persist.ts L5-L39](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/ResizableLayout/utils/persist.ts#L5-L39)、[MainScreen.tsx L220-L240](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/MainScreen.tsx#L220-L240)、[MainScreen.tsx L340-L354](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/MainScreen.tsx#L340-L354)（访问：2026-09-25）
- **一手源码**：`ui.layout` 是隐藏的 Desktop-only 文件设置，`isGlobal: false`；Setting 源码明确把 `isGlobal: false` 称为 local / per-profile，并把 `ui.layout` 列为从全局迁移到 per-profile 的设置。
  来源：[Joplin v3.7.18 — builtInMetadata.ts L1738-L1745](https://github.com/laurent22/joplin/blob/v3.7.18/packages/lib/models/settings/builtInMetadata.ts#L1738-L1745)、[Setting.ts L133-L147](https://github.com/laurent22/joplin/blob/v3.7.18/packages/lib/models/Setting.ts#L133-L147)（访问：2026-09-25）
- **显式设置核验**：公开命令中可见 `Toggle sidebar` 和 `Reset application layout`，后者清空 `ui.layout` 后重建默认布局；它是恢复默认，不是“每次启动强制展开”。
  来源：[Joplin v3.7.18 — resetLayout.ts](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/WindowCommandsAndDialogs/commands/resetLayout.ts)（访问：2026-09-25）
- **窗口边界**：独立笔记窗口把 layout 放在 `secondaryWindowLayout` 内存状态中；源码只在 `MainScreen` 中持久化 main layout。独立窗口在新进程没有该内存状态时使用自己的默认布局。
  来源：[Joplin v3.7.18 — app.reducer.ts L78-L84、L358-L383](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/app.reducer.ts#L78-L84)、[EditorWindow.tsx L45-L58](https://github.com/laurent22/joplin/blob/v3.7.18/packages/app-desktop/gui/NoteEditor/EditorWindow.tsx#L45-L58)（访问：2026-09-25）

### 判定

Joplin 采用“**每个 profile 一份完整主窗口布局**”。因为 Joplin 没有项目 / workspace 概念，sidebar 不会随 notebook 切换而变化。它证明把可见性、宽度等作为一个 layout bundle 持久化很直接，但也显示了一个限制：没有项目边界时，所有 notebook 会共享同一套布局。

## 横向结论

1. **自动恢复是三者共同做法。** 三者都会让同一上下文重开时恢复用户最后留下的布局，而不是每次使用固定默认值。
2. **“启动时始终展开”不是主侧栏的默认政策。** VS Code 主侧栏和 Obsidian 侧栏都没有同类普通设置；Joplin 也只提供默认布局和 Reset。
3. **状态作用域跟随用户心智模型。** 有项目 / vault / workspace 的产品按工作区保存；没有项目概念的 Joplin 按 profile 保存。把主侧栏可见性做成单一全局值，会让项目 A 的临时折叠污染项目 B。
4. **“没有历史状态时的默认值”与“记住上次”是两件事。** VS Code 对非空工作区默认展开、对空窗口默认折叠，正好说明首次默认值应结合当前上下文。
5. **应提供恢复默认的出口。** VS Code 可 reset layout，Joplin 有 `Reset application layout`；用户设置错位后不能只能手动逐项修。

## 对 Milkup 的设计建议

### 当前实现的含义

调查时的工作树中：

- `src/renderer/hooks/useConfig.ts` 把 `workspace.autoExpandSidebar` 放在单个全局 `milkup-config` localStorage 中。
- `src/renderer/App.vue` 每次启动直接用该布尔值初始化 `isShowOutline`；运行时切换不会反向保存“上次可见状态”。
- `src/renderer/components/outline/Outline.vue` 已把 `sidebar-active-tab` 记入单个 localStorage key，因此文件和大纲选择也是全局共享，而不是工作区共享。
- `src/main/windowManager.ts` 支持多个 Electron 窗口；各 renderer 的内存状态彼此独立，但上述 localStorage key 会被同一 origin 的窗口共享。

因此，现有 `autoExpandSidebar` 表达的是一条**全局启动政策**，还没有表达“每个项目最后处于什么状态”。这两个问题不应塞进同一个布尔值。

### 推荐的最小模型

1. **默认行为：记住当前工作区最后一次状态。**
   - 用户展开 / 折叠后立即写入当前工作区状态；这是低频用户动作，没有必要等干净退出才保存。
   - 至少保存 `sidebarVisible`；`activeTab` 和 `width` 可以放在同一 workspace layout bundle，但不要把动画中间态 `opening` / `closing` 持久化。
2. **保留旧启动字段作为兼容 fallback。**
   - 现有 `autoExpandSidebar` 不再作为实时状态，也不需要新增“记住状态”或“始终展开”模式。
   - 没有工作区历史状态时，继续使用 `autoExpandSidebar` 作为旧配置 fallback；一旦有历史状态，手动选择优先。
   - 设置页可以直接使用“显示侧边栏”控制当前状态，底部图标与开关调用同一个操作。
3. **实际布局按工作区 / 项目保存。**
   - 用规范化后的项目根目录标识工作区；切换项目时读取目标项目自己的状态，不把当前项目状态复制过去。
   - 没有项目、仅打开单文件时使用明确的 `standalone` 状态槽或上下文 fallback。
4. **首次启动 fallback 与恢复策略分开。**
   - 有项目但从未保存过状态：沿用旧配置的默认值。
   - 没有项目、仅打开单文件时：沿用旧配置的默认值；不额外改变现有首次启动行为。
5. **多窗口规则要显式。**
   - 每个窗口维护自己的当前显示状态；同一工作区持久化时采用最后一次用户操作。
   - 不让一个窗口的启动动作实时重排另一个窗口。

### 最小验收场景

- 项目 A 展开，重启 A：恢复展开。
- 项目 A 折叠，重启 A：恢复折叠；切到项目 B：使用 B 自己的状态或 fallback，不继承 A。
- 设置页“显示侧边栏”和左下角图标双向同步，且都立即改变当前窗口。
- 旧配置没有工作区状态时，仍按 `autoExpandSidebar` 初始化，且启动读取不会重写旧字段。
- 两个窗口分别操作不同项目：一个窗口的侧边栏变化不得改写另一个项目的状态。

## 核心建议

**Milkup 应把“旧的启动配置”与“工作区最后状态”分开；默认自动恢复每个工作区的最后状态，不增加是否记忆或始终展开的额外模式。**
