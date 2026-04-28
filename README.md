# Web

Obsidian 插件原型：通过本机 Codex CLI harness 跟随当前阅读上下文，把阅读中的问题、回答、旧笔记和跨书关联织成一张知识网。

## 当前能力

- 读取当前 Markdown 笔记、选区、光标附近段落、标题路径和文档大纲。
- 自动补充 frontmatter、tags、outlinks、backlinks、最近打开文件。
- 使用本地关键词检索全库 Markdown，返回相关笔记、历史问题节点和阅读线索。
- 按问题从 Agent-Memory 入口和相关 wiki 中提取只读记忆片段。
- 在正文中插入 `> [!question]- Web 提问`，并把回答写回为折叠 `> [!answer]- Web 回答`。
- 右侧面板是简化聊天框：上方消息流，下方输入框，发送时自动读取当前标注/上下文。
- 调用本机 `codex exec --json --sandbox read-only --skip-git-repo-check --ephemeral`。
- 自动追加 companion note 到 `AI阅读笔记/`。
- 每次提问自动沉淀为 `AI阅读笔记/问题节点/` 下的问题节点，并更新 `AI阅读笔记/问题索引.md`。
- 根据回答中的阅读线索，更新 `AI阅读笔记/阅读线索/` 下的线索文件。

## 右侧聊天

在正文中划选一段文字后，直接到右侧底部输入框提问。插件会自动带上当前选区、光标附近段落、标题路径、相关笔记、历史问题节点和阅读线索。

- `Enter` 发送
- `Shift+Enter` 换行
- 完成后自动写入阅读笔记、问题节点和问题索引

## 文中提问

在命令面板中使用：

- `插入 Web 问题块`
- `回答当前 Web 问题块`

问题块格式：

```md
> [!question]- Web 提问
> 这段话是什么意思？
> ^web-q-20260428113000-abcd
```

回答后会写成：

```md
> [!answer]- Web 回答
> 这里的关键是……
```

旧的 `Codex 提问` / `Codex 回答` callout 和 `^codex-q-...` block id 仍可识别。

## 开发

```bash
npm install
npm run build
```

构建后将 `main.js`、`manifest.json`、`styles.css` 复制或链接到 Obsidian vault 的 `.obsidian/plugins/web-reading-plugin/` 目录。

## v0.3 问题网络

Web 会要求 Codex 返回结构化 JSON：

- `answer`
- `currentMaterial`
- `relatedEchoes`
- `conceptLinks`
- `readingTrails`
- `proposedActions`

插件自动执行的写入只限于阅读笔记、问题节点、问题索引和阅读线索。创建概念卡片、写回原文、自动写 Agent-Memory 等动作不会自动执行。

## 当前边界

- 只支持 Obsidian 桌面端。
- 当前只支持 Markdown 当前笔记/选区。
- Codex 默认只读运行，插件只做白名单写入，不自动删除或改写原书原文。
- 暂不使用 embedding、图数据库或图谱可视化。
- PDF、EPUB、网页剪藏会在后续作为新的 `ReadingContext` 适配层加入。
