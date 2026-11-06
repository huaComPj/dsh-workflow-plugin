# README 截图 / README screenshots

[中文首页](<../../README.md>) · [English README](<../../README.en.md>)

中英文首页均已引用下面三张真实界面截图，分别提供中文和英文替代文本；保留原文件名和内容，不再使用文字占位。

Both READMEs embed these three supplied interface screenshots with localized alt text, preserving the original filenames and contents instead of using placeholders.

## 当前图片 / Current assets

| 图片 / Image | 展示内容 / Content |
| --- | --- |
| [ScreenShot_workflow-config.png](<ScreenShot_workflow-config.png>) | 可视化配置、节点连线、子流程与属性面板；图中是进阶配置，不是默认五节点模板。Advanced workflow editor, connections, subflows and properties. |
| [ScreenShot_start_workflow.png](<ScreenShot_start_workflow.png>) | 当前会话中的工作流选择与任务描述弹窗。Workflow selection and task prompt dialog. |
| [ScreenShot_workflow_monitor.png](<ScreenShot_workflow_monitor.png>) | 配套侧栏中的运行图、Actor / Judge、BLOCK 信息与执行记录；图中并非成功交付状态。Companion-sidebar monitor showing a blocked Run and execution details. |

## 社区截图声明 / Community screenshot manifest

仓库根目录的 [screenshots.json](<../../screenshots.json>) 按“配置 → 启动 → 监控”引用同一组三张图片，未新增或修改原图。该声明供社区目录采集，推送到远端后仍需等待收录与后续构建；本地有文件不等于市场已经显示，也不会自动改变已发布 npm 的 README。

The root [screenshots.json](<../../screenshots.json>) lists the same three images in configuration → launch → monitor order. Community collection requires the declaration to be pushed, the listing to be accepted and a subsequent catalog build; it does not update the published npm README or guarantee images in every market UI.

## 引用方式 / Embedding

从根 README 使用相对路径，并提供说明画面内容的替代文本：

```markdown
![工作流配置：节点连线、子流程与属性面板](<docs/images/ScreenShot_workflow-config.png>)
```

文件名大小写需与实际文件一致；没有另行生成图片、裁剪副本或模拟界面。

## 更新与公开前检查 / Before publishing

- 优先使用演示项目，统一主题、缩放与裁剪范围，保证插件区域和文字清晰。
- 当前启动/监控截图包含背景对话、费用、仓库和运行诊断信息；公开前确认这些内容允许展示，必要时另行裁剪或脱敏。
- 启动弹窗只用于演示选择和输入，不为截图实际启动任务；监控使用已有且获准展示的 Run。
- 「工作流监控」需要提供 `betterSidebar` 服务的配套侧栏；没有该侧栏不影响命令和配置编辑器。
- Review background conversations, costs, repository references and diagnostics before publishing. Redact or crop separately if needed; keep screenshots honest about advanced templates, optional sidebar features and BLOCK status.
