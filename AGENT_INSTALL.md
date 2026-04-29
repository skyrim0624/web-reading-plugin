# Web Obsidian 插件安装与使用说明

这份文档是给 Agent 用的。用户把它发给你后，你的任务是把 Web 插件安装到用户的 Obsidian vault 中，并教用户如何使用。

仓库地址：

```text
https://github.com/skyrim0624/web-reading-plugin
```

## Web 是什么

Web 是一个 Obsidian 桌面插件，用本机 Codex CLI harness 做 AI 精读：

- 用户在 Obsidian 里读 Markdown 笔记。
- 用户可以划选一段文字，在右侧 Web 面板直接提问。
- Web 会把当前文件、选区、附近段落、标题路径、相关旧笔记、历史问题节点和阅读线索一起发给 Codex。
- 回答会自动写入 `AI阅读笔记/`。
- 每次提问会沉淀为问题节点，并更新问题索引和阅读线索。

## 安装前确认

安装前先确认这些条件：

- 用户使用的是 Obsidian 桌面版。
- 用户已经有一个本地 Obsidian vault。
- 本机已安装 Node.js 和 npm。
- 本机已安装并登录 Codex CLI，终端里能运行 `codex`。

请先执行：

```bash
node --version
npm --version
which node
which codex
codex --version
```

如果 `which codex` 没有输出，先让用户安装并登录 Codex CLI。不要用 OpenAI-compatible Chat Completions API 替代；这个插件第一版接的是本机 Codex CLI harness。

## Agent 安装步骤

### 1. 获取用户 vault 路径

你需要知道用户 Obsidian vault 的本地路径，例如：

```text
/Users/alice/Documents/Obsidian/MyVault
```

如果用户没有告诉你路径，先问一句：

```text
你的 Obsidian vault 本地路径是什么？
```

下面所有命令用 `$VAULT_PATH` 表示这个路径。

### 2. 克隆并构建插件

```bash
cd /tmp
git clone https://github.com/skyrim0624/web-reading-plugin.git
cd web-reading-plugin
npm install
npm run build
```

构建成功后，仓库根目录会生成 `main.js`。

### 3. 安装到 Obsidian vault

```bash
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/web-reading-plugin"
mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"
```

### 4. 写入插件配置

用当前机器上的真实路径写 `data.json`：

```bash
NODE_COMMAND="$(which node)"
CODEX_COMMAND="$(which codex)"

cat > "$PLUGIN_DIR/data.json" <<EOF
{
  "nodeCommand": "$NODE_COMMAND",
  "codexCommand": "$CODEX_COMMAND",
  "noteFolder": "AI阅读笔记",
  "maxContextChars": 12000,
  "contextRadiusLines": 80,
  "includeAgentMemory": false,
  "agentMemoryIndexPath": "",
  "autoWriteNotes": true,
  "enableVaultRetrieval": true,
  "relatedNotesLimit": 5,
  "relatedNoteMaxChars": 800,
  "excludedFolders": ".obsidian, AI阅读笔记",
  "allowedFolders": "",
  "includeBacklinks": true,
  "includeRecentFiles": true,
  "allowConceptNotes": true
}
EOF
```

说明：

- `nodeCommand` 用来避免 Obsidian 环境里找不到 node。
- `codexCommand` 必须是本机 Codex CLI 的真实路径。
- `includeAgentMemory` 默认设为 `false`，因为这是作者个人知识库路径，其他用户通常没有。

### 5. 启用插件

确保 Obsidian 的社区插件列表包含 `web-reading-plugin`。

```bash
COMMUNITY_PLUGINS="$VAULT_PATH/.obsidian/community-plugins.json" node <<'NODE'
const fs = require("fs");
const path = process.env.COMMUNITY_PLUGINS;
const pluginId = "web-reading-plugin";
let plugins = [];
if (fs.existsSync(path)) {
  plugins = JSON.parse(fs.readFileSync(path, "utf8"));
}
if (!plugins.includes(pluginId)) {
  plugins.push(pluginId);
}
fs.writeFileSync(path, JSON.stringify(plugins, null, 2));
NODE
```

### 6. 重启或刷新 Obsidian

让用户重启 Obsidian，或者在 Obsidian 里关闭再打开社区插件。

安装完成后，命令面板里应该能看到：

- `打开 Web 面板`
- `插入 Web 问题块`
- `回答当前 Web 问题块`

## 使用方法

### 右侧聊天

1. 在 Obsidian 中打开一篇 Markdown、PDF 或 EPUB 文件。
2. 选中一段读不懂或想追问的文字。
3. 打开命令面板，执行 `打开 Web 面板`。
4. 在右侧底部输入框提问。
5. 按 `Enter` 发送，按 `Shift+Enter` 换行。

Web 会自动读取：

- 当前文件
- 当前选区
- 光标附近段落，或 PDF 页码 / EPUB 章节附近文本
- 标题路径，或 PDF 页码 / EPUB 章节
- backlinks / outlinks
- 最近打开文件
- vault 内相关笔记
- 历史问题节点
- 阅读线索

回答完成后，会自动写入：

- `AI阅读笔记/<当前文件名>-阅读笔记.md`
- `AI阅读笔记/问题节点/`
- `AI阅读笔记/问题索引.md`
- `AI阅读笔记/阅读线索/`

### 文中标注提问

如果用户想把问题直接标在原文旁边：

1. 在正文中把光标放到想提问的位置。
2. 执行命令 `插入 Web 问题块`。
3. 在生成的 callout 里写问题。
4. 把光标放在问题块内。
5. 执行命令 `回答当前 Web 问题块`。

问题块格式：

```md
> [!question]- Web 提问
> 这段话是什么意思？
> ^web-q-20260428113000-abcd
```

回答会写成：

```md
> [!answer]- Web 回答
> 这里的关键是……
```

## 常见问题

### Obsidian 里提示找不到 node

检查插件配置文件：

```bash
cat "$VAULT_PATH/.obsidian/plugins/web-reading-plugin/data.json"
```

确认 `nodeCommand` 是 `which node` 的结果。如果不是，重新写入：

```bash
NODE_COMMAND="$(which node)"
CODEX_COMMAND="$(which codex)"
```

然后重新生成 `data.json`。

### Codex 运行失败

先在终端测试：

```bash
cd "$VAULT_PATH"
printf '只输出 pong，不要解释。' | codex exec --json --cd "$VAULT_PATH" --sandbox read-only --skip-git-repo-check --ephemeral
```

如果这里失败，问题在 Codex CLI 登录、路径或本机权限，不在 Obsidian 插件。

### 看不到 Web 面板

确认这些文件存在：

```bash
ls "$VAULT_PATH/.obsidian/plugins/web-reading-plugin"
```

应该至少有：

```text
main.js
manifest.json
styles.css
data.json
```

再确认启用列表：

```bash
cat "$VAULT_PATH/.obsidian/community-plugins.json"
```

里面应该包含：

```json
"web-reading-plugin"
```

### 不想让它写很多笔记

在 Obsidian 插件设置里关闭 `自动写入阅读笔记`。关闭后，Web 仍可回答问题，但不会自动写入阅读笔记和问题网络。

## 安全边界

- Codex CLI 以 `read-only` sandbox 运行。
- Web 插件自己执行白名单写入。
- 默认只写 `AI阅读笔记/` 下的阅读笔记、问题节点、问题索引和阅读线索。
- 不会自动删除文件。
- 不会自动修改原书原文。
- 不会自动写入用户的长期 Agent-Memory。

## 给用户的最短说明

安装后，在 Obsidian 里打开一篇 Markdown、PDF 或 EPUB，执行 `打开 Web 面板`。读到卡住的地方，选中文字，直接在右侧输入框提问。Web 会解释当前材料，并把问题、回答和相关线索自动沉淀到 `AI阅读笔记/`。
