# README 截图 / README screenshots

[中文首页](<../../README.md>) · [English README](<../../README.en.md>)

目前首页保留文字占位，未链接不存在的图片，也没有把模拟图当作实际界面。补图后，将两份 README 中相应的占位段替换为图片。

The READMEs currently use text placeholders, not broken image links or simulated UI. Replace the matching blocks in both languages after capturing the real interface.

## 建议画面 / Suggested captures

| 文件名 / Filename | 画面 / Content |
| --- | --- |
| `workflow-editor.png` | 「工作流配置」画布：完整的节点连线与右侧角色属性。Workflow editor with connected nodes and role properties. |
| `workflow-start.png` | 「启动工作流」弹窗：模板选择与任务描述，停在提交之前。Launch dialog with template selection and task text, before submission. |
| `workflow-monitor.png` | 配套侧栏中的「工作流监控」：节点状态与子流程；需要提供 `betterSidebar` 的侧栏。Run monitor showing node progress and a subflow; requires the companion sidebar providing `betterSidebar`. |

## 拍摄要求 / Capture checklist

- 使用已安装插件的真实 DSH 页面，统一缩放与主题；优先裁剪到插件区域，文字需清晰可读。
- 使用演示项目，遮盖账号、私有仓库名、个人路径、凭据、任务正文与敏感错误信息。
- 只为截图打开编辑器或启动弹窗，不保存配置、不实际启动工作流。监控截图使用已有且获准展示的 Run，不为造图运行任务。
- 没有配套侧栏时可以先不补监控图，不要让图片暗示该页签在所有安装中默认存在。
- Capture the installed UI with consistent zoom/theme and readable text. Redact private data, use a demo project, and do not save configurations or start tasks solely to obtain screenshots. Use an existing, authorized Run for the optional monitor image.

将图片放在本目录，在两份根 README 中分别使用中文和英文替代文本，例如：

Place images in this directory and use localized alt text in the root READMEs:

```markdown
![工作流配置：节点连线与角色属性](<docs/images/workflow-editor.png>)
![Workflow editor with connected nodes and role properties](<docs/images/workflow-editor.png>)
```
