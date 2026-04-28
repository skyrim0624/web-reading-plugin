import {
  App,
  CachedMetadata,
  Editor,
  EditorPosition,
  FileSystemAdapter,
  ItemView,
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { dirname } from "path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Root, createRoot } from "react-dom/client";

const VIEW_TYPE_CODEX_READING = "web-reading-plugin-view";

interface CodexReadingSettings {
  nodeCommand: string;
  codexCommand: string;
  noteFolder: string;
  maxContextChars: number;
  contextRadiusLines: number;
  includeAgentMemory: boolean;
  agentMemoryIndexPath: string;
  autoWriteNotes: boolean;
  enableVaultRetrieval: boolean;
  relatedNotesLimit: number;
  relatedNoteMaxChars: number;
  excludedFolders: string;
  allowedFolders: string;
  includeBacklinks: boolean;
  includeRecentFiles: boolean;
  allowConceptNotes: boolean;
}

interface ReadingSelection {
  text: string;
  startLine: number;
  endLine: number;
}

interface SelectionAnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface SelectionSnapshot {
  filePath: string;
  text: string;
  from?: EditorPosition;
  to?: EditorPosition;
  rect?: SelectionAnchorRect;
  capturedAt: number;
}

interface MarkedSelectionResult {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  rect?: SelectionAnchorRect;
}

interface HeadingItem {
  level: number;
  text: string;
  line: number;
}

interface ReadingContext {
  vaultName: string;
  vaultPath: string;
  activeFilePath: string;
  activeFileName: string;
  activeFileBasename: string;
  cursorLine: number;
  headingPath: HeadingItem[];
  outline: HeadingItem[];
  selection?: ReadingSelection;
  surroundingText: string;
  fileExcerpt: string;
  agentMemoryExcerpt?: string;
  capturedAt: string;
}

interface RelatedNote {
  path: string;
  basename: string;
  reason: string;
  score: number;
  excerpt: string;
  sourceType: "note" | "questionNode" | "readingTrail";
}

interface RelatedEcho {
  path: string;
  relation: string;
  excerpt?: string;
}

interface ConceptLink {
  label: string;
  relation: string;
  sourcePath?: string;
  excerpt?: string;
  confidence?: number;
}

interface ReadingTrail {
  title: string;
  reason: string;
  relatedPaths: string[];
}

interface CodexStructuredResponse {
  answer: string;
  currentMaterial?: string;
  relatedEchoes: RelatedEcho[];
  conceptLinks: ConceptLink[];
  readingTrails: ReadingTrail[];
  proposedActions: NoteAction[];
}

interface PersistedQuestionRecord {
  questionNodePath: string;
  questionIndexPath: string;
  readingTrailPaths: string[];
}

interface ExtendedReadingContext extends ReadingContext {
  frontmatter?: Record<string, unknown>;
  tags: string[];
  outlinks: string[];
  backlinks: string[];
  recentFiles: string[];
  relatedNotes: RelatedNote[];
  availableActions: string[];
}

type NoteAction =
  | { type: "appendReadingNote"; targetPath: string; content: string }
  | { type: "insertAnswerCallout"; blockId: string; content: string }
  | { type: "createConceptNote"; title: string; content: string; needsConfirm: true }
  | { type: "openRelatedNote"; path: string };

interface CodexRunResult {
  answer: string;
  stderr: string;
  events: unknown[];
  structuredResponse: CodexStructuredResponse | null;
}

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  context?: ExtendedReadingContext;
  notePath?: string;
  questionNodePath?: string;
  readingTrailPaths?: string[];
  structuredResponse?: CodexStructuredResponse | null;
  isStreaming?: boolean;
}

interface ConnectorState {
  id: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface CodexQuestionBlock {
  startLine: number;
  endLine: number;
  question: string;
  blockId: string | null;
  answerStartLine: number | null;
  answerEndLine: number | null;
}

const DEFAULT_SETTINGS: CodexReadingSettings = {
  nodeCommand: "/Users/andreas/.local/bin/node",
  codexCommand: "/Users/andreas/.bun/bin/codex",
  noteFolder: "AI阅读笔记",
  maxContextChars: 12000,
  contextRadiusLines: 80,
  includeAgentMemory: true,
  agentMemoryIndexPath: "/Users/andreas/cmi社区知识库/CMI/Agent-Memory/INDEX.md",
  autoWriteNotes: true,
  enableVaultRetrieval: true,
  relatedNotesLimit: 5,
  relatedNoteMaxChars: 800,
  excludedFolders: ".obsidian, AI阅读笔记",
  allowedFolders: "",
  includeBacklinks: true,
  includeRecentFiles: true,
  allowConceptNotes: true,
};

export default class CodexReadingPlugin extends Plugin {
  settings: CodexReadingSettings = DEFAULT_SETTINGS;
  private lastMarkedText = "";
  private lastSelectionSnapshot: SelectionSnapshot | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_CODEX_READING,
      (leaf) => new CodexReadingView(leaf, this),
    );

    this.addRibbonIcon("book-open", "打开 Web", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-web-reading-view",
      name: "打开 Web 面板",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "refresh-codex-reading-context",
      name: "捕获当前阅读上下文",
      callback: async () => {
        try {
          await this.buildReadingContext();
          new Notice("已捕获当前阅读上下文");
        } catch (error) {
          new Notice(toErrorMessage(error));
        }
      },
    });

    this.addCommand({
      id: "insert-web-question-callout",
      name: "插入 Web 问题块",
      editorCallback: (editor) => {
        this.insertQuestionCallout(editor);
      },
    });

    this.addCommand({
      id: "answer-current-web-question-callout",
      name: "回答当前 Web 问题块",
      editorCallback: (editor, ctx) => {
        void this.answerCurrentQuestionCallout(editor, ctx);
      },
    });

    this.registerDomEvent(document, "selectionchange", () => {
      this.captureSelectionSnapshot();
    });

    this.addSettingTab(new CodexReadingSettingTab(this.app, this));
  }

  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_READING)) {
      leaf.detach();
    }
  }

  async activateView() {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_READING)[0];
    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("无法打开右侧面板");
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_CODEX_READING, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async buildReadingContext(
    source?: {
      editor: Editor;
      file: TFile;
    },
    query = "",
  ): Promise<ExtendedReadingContext> {
    const baseContext = await this.buildBaseReadingContext(source);
    return this.enrichReadingContext(baseContext, query);
  }

  async buildBaseReadingContext(source?: {
    editor: Editor;
    file: TFile;
  }): Promise<ReadingContext> {
    const markdownView = source ? null : this.getReadingMarkdownView();
    const file = source?.file ?? markdownView?.file;
    const editor = source?.editor ?? markdownView?.editor;

    if (!editor || !file) {
      throw new Error("请先打开一篇 Markdown 笔记");
    }

    if (file.extension !== "md") {
      throw new Error("第一版先支持 Markdown 笔记；PDF、EPUB 和网页剪藏会作为后续格式层加入");
    }

    const content = await this.app.vault.read(file);
    const cursor = editor.getCursor();
    const selectionSnapshot = this.getUsableSelectionSnapshot(file.path);
    const editorSelection = editor.getSelection();
    const selectedText =
      editorSelection || getCurrentDomSelectionText() || selectionSnapshot?.text;
    const selection = selectedText
      ? {
          text: trimToLimit(selectedText, this.settings.maxContextChars),
          startLine: editorSelection
            ? editor.getCursor("from").line + 1
            : (selectionSnapshot?.from?.line ?? editor.getCursor("from").line) + 1,
          endLine: editorSelection
            ? editor.getCursor("to").line + 1
            : (selectionSnapshot?.to?.line ?? editor.getCursor("to").line) + 1,
        }
      : undefined;
    const lines = content.split(/\r?\n/);
    const surroundingText = getSurroundingText(
      lines,
      cursor.line,
      this.settings.contextRadiusLines,
      this.settings.maxContextChars,
    );

    return {
      vaultName: this.app.vault.getName(),
      vaultPath: this.getVaultPath(),
      activeFilePath: file.path,
      activeFileName: file.name,
      activeFileBasename: file.basename,
      cursorLine: cursor.line + 1,
      headingPath: getHeadingPath(lines, cursor.line),
      outline: getOutline(lines),
      selection,
      surroundingText,
      fileExcerpt: buildFileExcerpt(content, cursor.line, this.settings.maxContextChars),
      agentMemoryExcerpt: undefined,
      capturedAt: new Date().toISOString(),
    };
  }

  async markActiveSelection(context: ReadingContext): Promise<MarkedSelectionResult | null> {
    if (!context.selection?.text.trim()) return null;

    const markdownView = this.getReadingMarkdownView();
    const file = markdownView?.file;
    const editor = markdownView?.editor;
    if (!file || !editor || file.path !== context.activeFilePath) return null;

    const snapshot = this.getUsableSelectionSnapshot(file.path);
    const editorSelection = editor.getSelection();

    if (editorSelection.trim()) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      const result = wrapEditorRangeWithHighlight(editor, file.path, from, to, snapshot?.rect);
      if (result) return result;
    }

    if (snapshot?.from && snapshot.to) {
      const selectedRange = editor.getRange(snapshot.from, snapshot.to);
      if (isSameLooseText(selectedRange, context.selection.text)) {
        const result = wrapEditorRangeWithHighlight(
          editor,
          file.path,
          snapshot.from,
          snapshot.to,
          snapshot.rect,
        );
        if (result) return result;
      }
    }

    return this.markSelectionByTextSearch(file, context, snapshot?.rect);
  }

  getSelectionAnchorRect(filePath?: string): SelectionAnchorRect | null {
    const snapshot = filePath
      ? this.getUsableSelectionSnapshot(filePath)
      : this.lastSelectionSnapshot;
    return snapshot?.rect ?? null;
  }

  async enrichReadingContext(context: ReadingContext, query = ""): Promise<ExtendedReadingContext> {
    const file = this.app.vault.getAbstractFileByPath(context.activeFilePath);
    if (!(file instanceof TFile)) {
      return createEmptyExtendedContext(context);
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = normalizeFrontmatter(cache?.frontmatter);
    const tags = getCacheTags(cache);
    const outlinks = getOutlinks(this.app, file, cache);
    const backlinks = this.settings.includeBacklinks ? getBacklinks(this.app, file) : [];
    const recentFiles = this.settings.includeRecentFiles ? this.getRecentFiles(context.activeFilePath) : [];
    const relatedNotes = this.settings.enableVaultRetrieval
      ? await this.retrieveRelatedNotes(context, {
          query,
          currentFile: file,
          tags,
          outlinks,
          backlinks,
          recentFiles,
        })
      : [];

    return {
      ...context,
      frontmatter,
      tags,
      outlinks,
      backlinks,
      recentFiles,
      relatedNotes,
      availableActions: getAvailableActions(this.settings),
      agentMemoryExcerpt: await this.readAgentMemoryExcerpt(context, relatedNotes, query),
    };
  }

  async retrieveRelatedNotes(
    context: ReadingContext,
    metadata: {
      query: string;
      currentFile: TFile;
      tags: string[];
      outlinks: string[];
      backlinks: string[];
      recentFiles: string[];
    },
  ): Promise<RelatedNote[]> {
    const terms = buildRetrievalTerms(context, metadata.tags, metadata.query);
    if (terms.length === 0) return [];

    const excludedFolders = parseFolderList(this.settings.excludedFolders);
    const allowedFolders = parseFolderList(this.settings.allowedFolders);
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const knowledgeNetworkFiles = allMarkdownFiles.filter((file) =>
      isKnowledgeNetworkPath(file.path, this.settings.noteFolder),
    );
    const regularFiles = allMarkdownFiles.filter((file) =>
      isPathAllowed(file.path, allowedFolders, excludedFolders),
    );
    const candidates = dedupeFiles([...regularFiles, ...knowledgeNetworkFiles]).filter(
      (file) => file.path !== metadata.currentFile.path,
    );
    const scoredNotes: RelatedNote[] = [];

    for (const file of candidates) {
      const cache = this.app.metadataCache.getFileCache(file);
      const content = await this.app.vault.cachedRead(file);
      const sourceType = getRelatedNoteSourceType(file.path, this.settings.noteFolder);
      const scoreParts = scoreRelatedNote(file, content, cache, terms, {
        outlinks: metadata.outlinks,
        backlinks: metadata.backlinks,
        recentFiles: metadata.recentFiles,
        sourceType,
      });

      if (scoreParts.score <= 0) continue;

      scoredNotes.push({
        path: file.path,
        basename: file.basename,
        reason: scoreParts.reasons.join("；"),
        score: scoreParts.score,
        excerpt: createRelevantExcerpt(content, terms, this.settings.relatedNoteMaxChars),
        sourceType,
      });
    }

    return scoredNotes
      .sort((left, right) => right.score - left.score)
      .slice(0, this.settings.relatedNotesLimit);
  }

  async askCodex(
    context: ExtendedReadingContext,
    question: string,
    history: ChatHistoryItem[] = [],
    onToken?: (token: string) => void,
  ): Promise<CodexRunResult> {
    const prompt = buildCodexPrompt(context, question, this.getCompanionNotePath(context), history);
    const result = await this.runCodex(prompt, context.vaultPath, onToken);
    const structuredResponse = parseCodexStructuredResponse(result.answer);
    return {
      ...result,
      answer: structuredResponse?.answer ?? result.answer,
      structuredResponse,
    };
  }

  async writeReadingNote(
    context: ReadingContext,
    question: string,
    answer: string,
    blockId?: string | null,
  ): Promise<string> {
    const targetPath = this.getCompanionNotePath(context);
    await this.ensureFolder(this.settings.noteFolder);

    const sourceLink = `[[${context.activeFilePath.replace(/\.md$/, "")}|${context.activeFileName}]]`;
    const selectedBlock = context.selection
      ? `\n**选区**\n\n> ${context.selection.text.replace(/\n/g, "\n> ")}\n`
      : "";
    const headingText = context.headingPath.map((heading) => heading.text).join(" / ") || "无";
    const entry = [
      "",
      `## ${formatLocalDateTime(new Date())} 精读记录`,
      "",
      `**来源**: ${sourceLink}`,
      `**位置**: 第 ${context.cursorLine} 行`,
      `**标题路径**: ${headingText}`,
      blockId ? `**问题锚点**: ^${blockId}` : null,
      selectedBlock,
      "**问题**",
      "",
      question.trim(),
      "",
      "**Web 回答**",
      "",
      answer.trim(),
      "",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, `${current.trimEnd()}\n${entry}`);
    } else {
      const header = [
        `# ${context.activeFileBasename} 阅读笔记`,
        "",
        `来源：${sourceLink}`,
        "",
      ].join("\n");
      await this.app.vault.create(targetPath, `${header}${entry}`);
    }

    return targetPath;
  }

  async persistQuestionRecord(
    context: ExtendedReadingContext,
    question: string,
    result: CodexRunResult,
  ): Promise<PersistedQuestionRecord> {
    const createdAt = new Date();
    const noteFolder = normalizePath(this.settings.noteFolder || DEFAULT_SETTINGS.noteFolder);
    const questionFolder = normalizePath(`${noteFolder}/问题节点`);
    const trailFolder = normalizePath(`${noteFolder}/阅读线索`);
    await this.ensureFolder(questionFolder);
    await this.ensureFolder(trailFolder);

    const response = result.structuredResponse ?? createFallbackStructuredResponse(result.answer);
    const questionNodePath = await this.createQuestionNode(
      questionFolder,
      context,
      question,
      response,
      createdAt,
    );
    const readingTrailPaths = await this.upsertReadingTrails(
      trailFolder,
      questionNodePath,
      context,
      question,
      response,
      createdAt,
    );
    const questionIndexPath = await this.updateQuestionIndex(
      noteFolder,
      questionNodePath,
      readingTrailPaths,
      context,
      question,
      response,
      createdAt,
    );

    return {
      questionNodePath,
      questionIndexPath,
      readingTrailPaths,
    };
  }

  private async createQuestionNode(
    questionFolder: string,
    context: ExtendedReadingContext,
    question: string,
    response: CodexStructuredResponse,
    createdAt: Date,
  ): Promise<string> {
    const slug = createSlug(question || context.activeFileBasename, 34);
    const basePath = normalizePath(
      `${questionFolder}/${formatDateForPath(createdAt)}-${slug}.md`,
    );
    const targetPath = this.getAvailableVaultPath(basePath);
    const markdown = formatQuestionNodeMarkdown(context, question, response, createdAt);
    await this.app.vault.create(targetPath, markdown);
    return targetPath;
  }

  private async updateQuestionIndex(
    noteFolder: string,
    questionNodePath: string,
    readingTrailPaths: string[],
    context: ExtendedReadingContext,
    question: string,
    response: CodexStructuredResponse,
    createdAt: Date,
  ): Promise<string> {
    const targetPath = normalizePath(`${noteFolder}/问题索引.md`);
    const sourceLink = formatWikiLink(context.activeFilePath, context.activeFileName);
    const nodeLink = formatWikiLink(questionNodePath, trimToLimit(question.replace(/\s+/g, " "), 60));
    const trailText = readingTrailPaths.length
      ? readingTrailPaths.map((path) => formatWikiLink(path)).join("、")
      : "无";
    const concepts = extractConceptLabels(response).join("、") || "无";
    const entry = [
      `- ${formatLocalDateTime(createdAt)} ${nodeLink}`,
      `  - 来源：${sourceLink}，第 ${context.cursorLine} 行`,
      `  - 概念：${concepts}`,
      `  - 阅读线索：${trailText}`,
    ].join("\n");

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, `${current.trimEnd()}\n${entry}\n`);
    } else {
      const header = [
        "# 问题索引",
        "",
        "这里自动记录 Web 在阅读中沉淀的问题节点，方便后续跨章节、跨书检索。",
        "",
      ].join("\n");
      await this.app.vault.create(targetPath, `${header}${entry}\n`);
    }

    return targetPath;
  }

  private async upsertReadingTrails(
    trailFolder: string,
    questionNodePath: string,
    context: ExtendedReadingContext,
    question: string,
    response: CodexStructuredResponse,
    createdAt: Date,
  ): Promise<string[]> {
    const paths: string[] = [];
    for (const trail of response.readingTrails.slice(0, 3)) {
      const title = trail.title.trim();
      if (!title) continue;

      const trailFileName = sanitizeFileName(title) || "未命名线索";
      const targetPath = normalizePath(`${trailFolder}/${trailFileName}.md`);
      const entry = formatReadingTrailEntry(
        trail,
        questionNodePath,
        context,
        question,
        response,
        createdAt,
      );
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        const current = await this.app.vault.read(existing);
        await this.app.vault.modify(existing, `${current.trimEnd()}\n${entry}`);
      } else {
        const header = [
          `# ${title}`,
          "",
          "这是一条由 Web 自动维护的阅读线索，用来连接不同材料里的相似问题、概念和解释路径。",
          "",
          "## 问题记录",
          "",
        ].join("\n");
        await this.app.vault.create(targetPath, `${header}${entry}`);
      }
      paths.push(targetPath);
    }
    return paths;
  }

  private getAvailableVaultPath(path: string): string {
    const dotIndex = path.lastIndexOf(".");
    const base = dotIndex >= 0 ? path.slice(0, dotIndex) : path;
    const extension = dotIndex >= 0 ? path.slice(dotIndex) : "";
    let candidate = path;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base}-${counter}${extension}`;
      counter += 1;
    }
    return candidate;
  }

  private async runCodex(
    prompt: string,
    vaultPath: string,
    onToken?: (token: string) => void,
  ): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const args = [
        "exec",
        "--json",
        "--cd",
        vaultPath,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
      ];
      const { command, spawnArgs, env } = this.createCodexSpawnConfig(args);
      const child = spawn(command, spawnArgs, {
        cwd: vaultPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const events: unknown[] = [];
      const streamedTextParts: string[] = [];
      const completedMessageParts: string[] = [];
      const rawTextParts: string[] = [];
      let stdoutBuffer = "";
      let stderr = "";
      let settled = false;

      child.on("error", (error) => {
        settled = true;
        reject(new Error(`无法启动 Codex CLI：${error.message}`));
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          consumeCodexLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("close", (code) => {
        if (settled) return;
        if (stdoutBuffer.trim()) {
          consumeCodexLine(stdoutBuffer);
        }

        const streamedAnswer = streamedTextParts.join("").trim();
        const completedAnswer = selectBestText(completedMessageParts).trim();
        const fallbackAnswer = selectBestAssistantText(events).trim() || rawTextParts.join("\n").trim();
        const answer = streamedAnswer || completedAnswer || fallbackAnswer;

        if (code !== 0) {
          reject(
            new Error(
              `Codex 运行失败（退出码 ${code ?? "unknown"}）\n${trimToLimit(stderr.trim(), 2000)}`,
            ),
          );
          return;
        }

        if (!answer) {
          reject(new Error(`Codex 没有返回可显示的回答\n${trimToLimit(stderr.trim(), 2000)}`));
          return;
        }

        resolve({ answer, stderr, events, structuredResponse: null });
      });

      child.stdin.write(prompt);
      child.stdin.end();

      const consumeCodexLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const event = JSON.parse(trimmed) as unknown;
          events.push(event);
          const delta = extractCodexDelta(event);
          if (delta) {
            streamedTextParts.push(delta);
            onToken?.(delta);
            return;
          }

          const completedText = extractAssistantMessageText(event);
          if (completedText) {
            completedMessageParts.push(completedText);
          }
        } catch {
          rawTextParts.push(line);
          onToken?.(`${line}\n`);
        }
      };
    });
  }

  private insertQuestionCallout(editor: Editor) {
    const blockId = createQuestionBlockId();
    const selectedText = editor.getSelection().trim();
    const questionText = selectedText
      ? [
          "这段话是什么意思？",
          "",
          "选中原文：",
          ...selectedText.split(/\r?\n/).map((line) => `> ${line}`),
        ].join("\n")
      : "在这里写下你的问题。";
    const callout = [
      "",
      "> [!question]- Web 提问",
      ...questionText.split(/\r?\n/).map((line) => `> ${line}`),
      `> ^${blockId}`,
      "",
    ].join("\n");

    const insertAt = editor.somethingSelected() ? editor.getCursor("to") : editor.getCursor();
    editor.replaceRange(callout, insertAt);
    editor.setCursor({
      line: insertAt.line + 2,
      ch: 2,
    });
    new Notice("已插入 Web 问题块");
  }

  private async answerCurrentQuestionCallout(
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo,
  ) {
    const file = ctx.file;
    if (!file) {
      new Notice("当前编辑器没有对应的 Markdown 文件");
      return;
    }

    const block = findQuestionBlockAtCursor(editor);
    if (!block) {
      new Notice("请把光标放在 Web 问题块里");
      return;
    }

    if (!block.question.trim()) {
      new Notice("问题块里还没有问题");
      return;
    }

    const blockId = block.blockId ?? createQuestionBlockId();
    let workingBlock = block;
    if (!block.blockId) {
      workingBlock = insertQuestionBlockId(editor, block, blockId);
    }

    new Notice("Web 正在回答当前问题块...");

    try {
      const context = await this.buildReadingContext({ editor, file }, workingBlock.question);
      const result = await this.askCodex(
        context,
        [
          "这是用户在 Obsidian 正文中标注的 Web 问题块。",
          "",
          "请回答这个问题，并让回答适合直接写回该问题块下方的折叠回答 callout。",
          "",
          workingBlock.question,
        ].join("\n"),
        [],
      );

      const updatedBlock = replaceAnswerCallout(editor, workingBlock, result.answer);
      await this.writeReadingNote(
        context,
        workingBlock.question,
        formatAnswerForReadingNote(result),
        blockId,
      );
      await this.persistQuestionRecord(context, workingBlock.question, result);
      editor.setCursor({
        line: updatedBlock.answerStartLine ?? updatedBlock.endLine,
        ch: 0,
      });
      new Notice("已写回 Web 回答并记录问题节点");
    } catch (error) {
      new Notice(toErrorMessage(error));
    }
  }

  private createCodexSpawnConfig(args: string[]): {
    command: string;
    spawnArgs: string[];
    env: NodeJS.ProcessEnv;
  } {
    const codexCommand = this.settings.codexCommand.trim() || DEFAULT_SETTINGS.codexCommand;
    const nodeCommand = this.settings.nodeCommand.trim() || DEFAULT_SETTINGS.nodeCommand;
    const useNodeWrapper = Boolean(nodeCommand) && looksLikePath(codexCommand);
    const command = useNodeWrapper ? nodeCommand : codexCommand;
    const spawnArgs = useNodeWrapper ? [codexCommand, ...args] : args;
    const env = {
      ...process.env,
      PATH: buildChildPath([nodeCommand, codexCommand], process.env.PATH),
    };

    return { command, spawnArgs, env };
  }

  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    const adapterLike = adapter as { getBasePath?: () => string; basePath?: string };
    const basePath = adapterLike.getBasePath?.() ?? adapterLike.basePath;
    if (!basePath) {
      throw new Error("无法获取 vault 本地路径；Web 目前只支持桌面端本地 vault");
    }
    return basePath;
  }

  private getReadingMarkdownView(): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) return activeView;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        return leaf.view;
      }
    }

    return null;
  }

  private getCompanionNotePath(context: ReadingContext): string {
    const folder = normalizePath(this.settings.noteFolder || DEFAULT_SETTINGS.noteFolder);
    return normalizePath(`${folder}/${context.activeFileBasename}-阅读笔记.md`);
  }

  private async ensureFolder(folderPath: string) {
    const normalized = normalizePath(folderPath);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) {
        throw new Error(`无法创建笔记目录，路径已被文件占用：${current}`);
      }
      await this.app.vault.createFolder(current);
    }
  }

  private async readAgentMemoryExcerpt(
    context?: ReadingContext,
    relatedNotes: RelatedNote[] = [],
    query = "",
  ): Promise<string | undefined> {
    if (!this.settings.includeAgentMemory) return undefined;

    const indexPath = this.settings.agentMemoryIndexPath.trim();
    if (!indexPath) return undefined;

    const targets = new Set<string>([indexPath]);
    const memoryRoot = indexPath.replace(/\/INDEX\.md$/, "");
    const terms = context ? buildRetrievalTerms(context, [], query) : [];

    for (const relatedNote of relatedNotes) {
      if (relatedNote.path.startsWith("Agent-Memory/")) {
        targets.add(`${memoryRoot}/${relatedNote.path.replace(/^Agent-Memory\//, "")}`);
      }
    }

    try {
      const indexContent = await fs.readFile(indexPath, "utf8");
      const wikiLinks = extractWikiLinks(indexContent);
      for (const link of wikiLinks) {
        if (!terms.some((term) => link.toLowerCase().includes(term.toLowerCase()))) continue;
        targets.add(`${memoryRoot}/${link}.md`);
      }
    } catch {
      return undefined;
    }

    const excerpts: string[] = [];
    for (const target of Array.from(targets).slice(0, 4)) {
      try {
        const content = await fs.readFile(target, "utf8");
        excerpts.push(`来源：${target}\n${trimToLimit(content, target === indexPath ? 2500 : 1800)}`);
      } catch {
        // 忽略不存在或无法读取的记忆文件。
      }
    }

    return excerpts.length > 0 ? excerpts.join("\n\n---\n\n") : undefined;
  }

  private getRecentFiles(activeFilePath: string): string[] {
    return this.app.workspace
      .getLastOpenFiles()
      .filter((path) => path !== activeFilePath)
      .filter((path) => path.endsWith(".md"))
      .slice(0, 10);
  }

  private captureSelectionSnapshot() {
    const selectedText = getCurrentDomSelectionText();
    if (!selectedText) return;

    const markdownView = this.getReadingMarkdownView();
    const file = markdownView?.file;
    if (!file) return;

    const editor = markdownView.editor;
    const editorSelection = editor.getSelection();
    const hasEditorSelection = Boolean(editorSelection.trim());
    const rect = getCurrentSelectionAnchorRect() ?? this.lastSelectionSnapshot?.rect;

    this.lastMarkedText = trimToLimit(selectedText, this.settings.maxContextChars);
    this.lastSelectionSnapshot = {
      filePath: file.path,
      text: this.lastMarkedText,
      from: hasEditorSelection ? cloneEditorPosition(editor.getCursor("from")) : undefined,
      to: hasEditorSelection ? cloneEditorPosition(editor.getCursor("to")) : undefined,
      rect: rect ?? undefined,
      capturedAt: Date.now(),
    };
  }

  private getUsableSelectionSnapshot(filePath: string): SelectionSnapshot | null {
    if (!this.lastSelectionSnapshot) return null;
    if (this.lastSelectionSnapshot.filePath !== filePath) return null;
    if (Date.now() - this.lastSelectionSnapshot.capturedAt > 10 * 60 * 1000) return null;
    return this.lastSelectionSnapshot;
  }

  private async markSelectionByTextSearch(
    file: TFile,
    context: ReadingContext,
    rect?: SelectionAnchorRect,
  ): Promise<MarkedSelectionResult | null> {
    const selectedText = context.selection?.text.trim();
    if (!selectedText) return null;

    const content = await this.app.vault.read(file);
    const range = findSelectionRangeInContent(content, selectedText, context.cursorLine);
    if (!range) return null;
    if (isContentRangeAlreadyHighlighted(content, range.start, range.end)) {
      return {
        filePath: file.path,
        text: content.slice(range.start, range.end),
        startLine: getLineNumberAtOffset(content, range.start),
        endLine: getLineNumberAtOffset(content, range.end),
        rect,
      };
    }

    const original = content.slice(range.start, range.end);
    const updated = `${content.slice(0, range.start)}==${original}==${content.slice(range.end)}`;
    await this.app.vault.modify(file, updated);

    return {
      filePath: file.path,
      text: original,
      startLine: getLineNumberAtOffset(content, range.start),
      endLine: getLineNumberAtOffset(content, range.end),
      rect,
    };
  }
}

class CodexReadingView extends ItemView {
  private readonly plugin: CodexReadingPlugin;
  private root: Root | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CodexReadingPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CODEX_READING;
  }

  getDisplayText(): string {
    return "Web";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    const mount = container.createDiv({ cls: "codex-reading-root" });
    this.root = createRoot(mount);
    this.root.render(<CodexReadingPanel plugin={this.plugin} />);
  }

  async onClose() {
    this.root?.unmount();
    this.root = null;
  }
}

function CodexReadingPanel({ plugin }: { plugin: CodexReadingPlugin }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [context, setContext] = useState<ReadingContext | null>(null);
  const [connector, setConnector] = useState<ConnectorState | null>(null);
  const [running, setRunning] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const connectorTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const contextSummary = useMemo(() => {
    if (!context) return null;
    return {
      source: context.activeFilePath,
      heading: context.headingPath.map((heading) => heading.text).join(" / ") || "无",
      selection: context.selection?.text
        ? trimToLimit(context.selection.text.replace(/\s+/g, " "), 220)
        : "无选区",
      line: context.cursorLine,
    };
  }, [context]);

  const refreshContextQuietly = useCallback(async () => {
    try {
      const nextContext = await plugin.buildReadingContext();
      setContext(nextContext);
    } catch (refreshError) {
      setContext(null);
    }
  }, [plugin]);

  useEffect(() => {
    void refreshContextQuietly();
    const interval = window.setInterval(() => {
      void refreshContextQuietly();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [refreshContextQuietly]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, running]);

  const clearConnectorTimer = useCallback(() => {
    if (connectorTimerRef.current !== null) {
      window.clearTimeout(connectorTimerRef.current);
      connectorTimerRef.current = null;
    }
  }, []);

  const showSelectionConnector = useCallback(
    (anchorRect: SelectionAnchorRect | null) => {
      const composerRect = composerRef.current?.getBoundingClientRect();
      if (!anchorRect || !composerRect) return;
      clearConnectorTimer();
      setConnector({
        id: createMessageId(),
        startX: composerRect.left - 6,
        startY: composerRect.top + composerRect.height / 2,
        endX: anchorRect.right + 4,
        endY: anchorRect.top + anchorRect.height / 2,
      });
    },
    [clearConnectorTimer],
  );

  const hideSelectionConnectorSoon = useCallback(
    (delay = 1600) => {
      clearConnectorTimer();
      connectorTimerRef.current = window.setTimeout(() => {
        setConnector(null);
        connectorTimerRef.current = null;
      }, delay);
    },
    [clearConnectorTimer],
  );

  useEffect(() => {
    return () => {
      clearConnectorTimer();
    };
  }, [clearConnectorTimer]);

  const askCodex = useCallback(async () => {
    const question = draft.trim();
    if (!question) {
      return;
    }

    setRunning(true);
    setDraft("");

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: question,
    };
    const assistantId = createMessageId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      isStreaming: true,
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    showSelectionConnector(plugin.getSelectionAnchorRect());

    try {
      const nextContext = await plugin.buildReadingContext();
      setContext(nextContext);
      const markedSelection = await plugin.markActiveSelection(nextContext);
      showSelectionConnector(
        markedSelection?.rect ?? plugin.getSelectionAnchorRect(nextContext.activeFilePath),
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === userMessage.id ? { ...message, context: nextContext } : message,
        ),
      );

      const history = messages
        .filter((message): message is ChatMessage & { role: "user" | "assistant" } => {
          return message.role === "user" || message.role === "assistant";
        })
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }));

      const result = await plugin.askCodex(nextContext, question, history);
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: result.answer,
                context: nextContext,
                structuredResponse: result.structuredResponse,
                isStreaming: false,
              }
            : message,
        ),
      );

      if (plugin.settings.autoWriteNotes) {
        const notePath = await plugin.writeReadingNote(
          nextContext,
          question,
          formatAnswerForReadingNote(result),
        );
        const persistedRecord = await plugin.persistQuestionRecord(nextContext, question, result);
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  notePath,
                  questionNodePath: persistedRecord.questionNodePath,
                  readingTrailPaths: persistedRecord.readingTrailPaths,
                }
              : message,
          ),
        );
      }
    } catch (askError) {
      const message = toErrorMessage(askError);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, role: "system", content: message, isStreaming: false }
            : item,
        ),
      );
      new Notice(message);
    } finally {
      setRunning(false);
      hideSelectionConnectorSoon();
    }
  }, [draft, hideSelectionConnectorSoon, messages, plugin, showSelectionConnector]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (!running) {
        void askCodex();
      }
    },
    [askCodex, running],
  );

  return (
    <div className="codex-reading-view">
      <SelectionConnectorOverlay connector={connector} />
      <div className="codex-reading-header">
        <div className="codex-reading-title">Web</div>
        {contextSummary ? (
          <div className="codex-reading-context-line">
            <span>{contextSummary.source}</span>
            <span>第 {contextSummary.line} 行</span>
            <span>{contextSummary.selection === "无选区" ? "未标注" : "已标注"}</span>
          </div>
        ) : (
          <div className="codex-reading-context-line">打开 Markdown 后即可提问</div>
        )}
      </div>

      <div className="codex-chat-list">
        {messages.length === 0 ? (
          <div className="codex-chat-empty">
            <div className="codex-chat-empty-mark">Web</div>
            <div className="codex-chat-empty-title">等待你的阅读问题</div>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            className={`codex-chat-message codex-chat-message-${message.role}`}
            key={message.id}
          >
            <div className="codex-chat-message-label">
              {message.role === "user" ? "你" : message.role === "assistant" ? "Web" : "系统"}
            </div>
            <div className="codex-chat-message-content">
              {message.structuredResponse ? (
                <StructuredAnswer response={message.structuredResponse} />
              ) : (
                message.content || (message.isStreaming ? "Web 正在阅读..." : "")
              )}
            </div>
            {message.context?.selection?.text ? (
              <div className="codex-chat-selection">
                标注：{trimToLimit(message.context.selection.text.replace(/\s+/g, " "), 180)}
              </div>
            ) : null}
            {message.notePath ? (
              <div className="codex-reading-note-path">已写入：{message.notePath}</div>
            ) : null}
            {message.questionNodePath ? (
              <div className="codex-reading-note-path">问题节点：{message.questionNodePath}</div>
            ) : null}
            {message.readingTrailPaths?.length ? (
              <div className="codex-reading-note-path">
                阅读线索：{message.readingTrailPaths.join("、")}
              </div>
            ) : null}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="codex-chat-composer" ref={composerRef}>
        <textarea
          className="codex-chat-input"
          disabled={running}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="问这段文字、概念或线索..."
          value={draft}
        />
        <button
          aria-label={running ? "Web 正在阅读" : "发送给 Web"}
          className="mod-cta codex-chat-send"
          disabled={running || !draft.trim()}
          onClick={askCodex}
          title={running ? "Web 正在阅读" : "发送"}
        >
          <span aria-hidden="true" className="codex-chat-send-icon">
            {running ? "..." : "↑"}
          </span>
        </button>
      </div>
    </div>
  );
}

function StructuredAnswer({ response }: { response: CodexStructuredResponse }) {
  return (
    <div className="codex-structured-answer">
      <AnswerSection title="直接解释" content={response.answer} />
      <AnswerSection title="当前材料依据" content={response.currentMaterial} />
      {response.relatedEchoes.length ? (
        <div className="codex-answer-section">
          <div className="codex-answer-section-title">其他笔记/书里的回声</div>
          {response.relatedEchoes.map((echo, index) => (
            <div className="codex-answer-list-item" key={`${echo.path}-${index}`}>
              <div className="codex-answer-path">{echo.path}</div>
              <div>{echo.relation}</div>
              {echo.excerpt ? <blockquote>{echo.excerpt}</blockquote> : null}
            </div>
          ))}
        </div>
      ) : null}
      {response.conceptLinks.length ? (
        <div className="codex-answer-section">
          <div className="codex-answer-section-title">概念关联</div>
          {response.conceptLinks.map((link, index) => (
            <div className="codex-answer-list-item" key={`${link.label}-${index}`}>
              <strong>{link.label}</strong>：{link.relation}
              {link.sourcePath ? <div className="codex-answer-path">{link.sourcePath}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {response.readingTrails.length ? (
        <div className="codex-answer-section">
          <div className="codex-answer-section-title">阅读线索</div>
          {response.readingTrails.map((trail, index) => (
            <div className="codex-answer-list-item" key={`${trail.title}-${index}`}>
              <strong>{trail.title}</strong>：{trail.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AnswerSection({ title, content }: { title: string; content?: string }) {
  if (!content?.trim()) return null;
  return (
    <div className="codex-answer-section">
      <div className="codex-answer-section-title">{title}</div>
      <div>{content}</div>
    </div>
  );
}

function SelectionConnectorOverlay({ connector }: { connector: ConnectorState | null }) {
  if (!connector) return null;

  const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  const direction = connector.startX > connector.endX ? -1 : 1;
  const distance = Math.abs(connector.startX - connector.endX);
  const controlOffset = Math.max(72, Math.min(distance * 0.42, 260));
  const path = [
    `M ${connector.startX} ${connector.startY}`,
    `C ${connector.startX + direction * controlOffset} ${connector.startY}`,
    `${connector.endX - direction * controlOffset * 0.45} ${connector.endY}`,
    `${connector.endX} ${connector.endY}`,
  ].join(" ");

  return createPortal(
    <div aria-hidden="true" className="codex-selection-connector" key={connector.id}>
      <svg
        className="codex-selection-connector-svg"
        height={viewportHeight}
        width={viewportWidth}
      >
        <path className="codex-selection-connector-path-shadow" d={path} />
        <path className="codex-selection-connector-path" d={path} />
      </svg>
      <div
        className="codex-selection-plunger"
        style={{
          left: connector.endX,
          top: connector.endY,
        }}
      >
        <span className="codex-selection-plunger-head" />
        <span className="codex-selection-plunger-stick" />
      </div>
    </div>,
    document.body,
  );
}

class CodexReadingSettingTab extends PluginSettingTab {
  private readonly plugin: CodexReadingPlugin;

  constructor(app: App, plugin: CodexReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Web 设置" });

    new Setting(containerEl)
      .setName("Node 命令")
      .setDesc("用于启动 Codex CLI，避免 Obsidian 环境里找不到 node。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.nodeCommand)
          .setValue(this.plugin.settings.nodeCommand)
          .onChange(async (value) => {
            this.plugin.settings.nodeCommand = value.trim() || DEFAULT_SETTINGS.nodeCommand;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Codex 命令")
      .setDesc("建议填写 Codex CLI 的完整路径。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.codexCommand)
          .setValue(this.plugin.settings.codexCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCommand = value.trim() || DEFAULT_SETTINGS.codexCommand;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("阅读笔记目录")
      .setDesc("Web 回答会追加到这个目录下的 companion note。")
      .addText((text) =>
        text
          .setPlaceholder("AI阅读笔记")
          .setValue(this.plugin.settings.noteFolder)
          .onChange(async (value) => {
            this.plugin.settings.noteFolder = value.trim() || DEFAULT_SETTINGS.noteFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("自动写入阅读笔记")
      .setDesc("开启后，每次回答都会自动追加到 companion note。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoWriteNotes).onChange(async (value) => {
          this.plugin.settings.autoWriteNotes = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("开启全库检索")
      .setDesc("发送问题时，从 vault 中检索相关 Markdown 片段。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableVaultRetrieval).onChange(async (value) => {
          this.plugin.settings.enableVaultRetrieval = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("相关笔记数量")
      .setDesc("传给 Codex 的相关笔记 topK。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.relatedNotesLimit))
          .setValue(String(this.plugin.settings.relatedNotesLimit))
          .onChange(async (value) => {
            this.plugin.settings.relatedNotesLimit = parsePositiveInteger(
              value,
              DEFAULT_SETTINGS.relatedNotesLimit,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("单篇相关笔记最大字符数")
      .setDesc("每篇相关笔记传给 Codex 的片段长度。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.relatedNoteMaxChars))
          .setValue(String(this.plugin.settings.relatedNoteMaxChars))
          .onChange(async (value) => {
            this.plugin.settings.relatedNoteMaxChars = parsePositiveInteger(
              value,
              DEFAULT_SETTINGS.relatedNoteMaxChars,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("排除文件夹")
      .setDesc("逗号分隔；默认排除 Obsidian 配置和 AI 阅读笔记，避免自我污染。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.excludedFolders)
          .setValue(this.plugin.settings.excludedFolders)
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value.trim() || DEFAULT_SETTINGS.excludedFolders;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("允许检索文件夹")
      .setDesc("逗号分隔；留空表示全库 Markdown。")
      .addText((text) =>
        text
          .setPlaceholder("留空为全库")
          .setValue(this.plugin.settings.allowedFolders)
          .onChange(async (value) => {
            this.plugin.settings.allowedFolders = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("包含 backlinks")
      .setDesc("把指向当前文件的笔记路径放入上下文，并给检索加权。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeBacklinks).onChange(async (value) => {
          this.plugin.settings.includeBacklinks = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("包含最近打开文件")
      .setDesc("把最近打开的 Markdown 放入上下文，并给检索加权。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeRecentFiles).onChange(async (value) => {
          this.plugin.settings.includeRecentFiles = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("允许建议创建概念卡片")
      .setDesc("Codex 只能提出建议，实际创建仍需确认。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowConceptNotes).onChange(async (value) => {
          this.plugin.settings.allowConceptNotes = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("上下文最大字符数")
      .setDesc("控制发给 Codex 的当前文件摘录长度。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxContextChars))
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (value) => {
            this.plugin.settings.maxContextChars = parsePositiveInteger(
              value,
              DEFAULT_SETTINGS.maxContextChars,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("附近段落行数")
      .setDesc("从光标附近截取多少行作为阅读现场。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.contextRadiusLines))
          .setValue(String(this.plugin.settings.contextRadiusLines))
          .onChange(async (value) => {
            this.plugin.settings.contextRadiusLines = parsePositiveInteger(
              value,
              DEFAULT_SETTINGS.contextRadiusLines,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("接入 Agent-Memory")
      .setDesc("将 Agent-Memory 入口文件片段作为长期上下文提示。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeAgentMemory).onChange(async (value) => {
          this.plugin.settings.includeAgentMemory = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Agent-Memory 入口文件")
      .setDesc("默认读取 INDEX.md 的片段；读取失败时会自动忽略。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.agentMemoryIndexPath)
          .setValue(this.plugin.settings.agentMemoryIndexPath)
          .onChange(async (value) => {
            this.plugin.settings.agentMemoryIndexPath =
              value.trim() || DEFAULT_SETTINGS.agentMemoryIndexPath;
            await this.plugin.saveSettings();
          }),
      );
  }
}

function createEmptyExtendedContext(context: ReadingContext): ExtendedReadingContext {
  return {
    ...context,
    tags: [],
    outlinks: [],
    backlinks: [],
    recentFiles: [],
    relatedNotes: [],
    availableActions: [],
  };
}

function normalizeFrontmatter(
  frontmatter: CachedMetadata["frontmatter"] | undefined,
): Record<string, unknown> | undefined {
  if (!frontmatter) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "position") continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function getCacheTags(cache: CachedMetadata | null): string[] {
  const tags = new Set<string>();
  for (const tag of cache?.tags ?? []) {
    tags.add(tag.tag);
  }

  const frontmatterTags = cache?.frontmatter?.tags ?? cache?.frontmatter?.tag;
  if (Array.isArray(frontmatterTags)) {
    for (const tag of frontmatterTags) {
      if (typeof tag === "string") tags.add(tag.startsWith("#") ? tag : `#${tag}`);
    }
  } else if (typeof frontmatterTags === "string") {
    for (const tag of frontmatterTags.split(/[,\s]+/)) {
      if (tag) tags.add(tag.startsWith("#") ? tag : `#${tag}`);
    }
  }

  return Array.from(tags);
}

function getOutlinks(app: App, file: TFile, cache: CachedMetadata | null): string[] {
  const links = new Set<string>();
  for (const link of [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])]) {
    const destination = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
    links.add(destination?.path ?? link.link);
  }
  return Array.from(links);
}

function getBacklinks(app: App, file: TFile): string[] {
  const backlinks: string[] = [];
  for (const [sourcePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (destinations[file.path]) backlinks.push(sourcePath);
  }
  return backlinks;
}

function getAvailableActions(settings: CodexReadingSettings): NoteAction["type"][] {
  const actions: NoteAction["type"][] = ["appendReadingNote", "openRelatedNote"];
  actions.push("insertAnswerCallout");
  if (settings.allowConceptNotes) {
    actions.push("createConceptNote");
  }
  return actions;
}

function parseFolderList(value: string): string[] {
  return value
    .split(",")
    .map((item) => normalizePath(item.trim()))
    .filter(Boolean);
}

function isPathAllowed(path: string, allowedFolders: string[], excludedFolders: string[]): boolean {
  if (excludedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
    return false;
  }
  if (allowedFolders.length === 0) return true;
  return allowedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

function dedupeFiles(files: TFile[]): TFile[] {
  const seen = new Set<string>();
  const result: TFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push(file);
  }
  return result;
}

function getRelatedNoteSourceType(
  path: string,
  noteFolder: string,
): RelatedNote["sourceType"] {
  const folder = normalizePath(noteFolder || DEFAULT_SETTINGS.noteFolder);
  if (path.startsWith(`${folder}/问题节点/`)) return "questionNode";
  if (path.startsWith(`${folder}/阅读线索/`)) return "readingTrail";
  return "note";
}

function isKnowledgeNetworkPath(path: string, noteFolder: string): boolean {
  const sourceType = getRelatedNoteSourceType(path, noteFolder);
  return sourceType === "questionNode" || sourceType === "readingTrail";
}

function buildRetrievalTerms(
  context: ReadingContext,
  tags: string[] = [],
  query = "",
): string[] {
  const termWeights = new Map<string, number>();
  const addTerm = (term: string, weight: number) => {
    const normalized = normalizeTerm(term);
    if (!normalized || normalized.length < 2) return;
    termWeights.set(normalized, Math.max(termWeights.get(normalized) ?? 0, weight));
  };

  addTerm(query, 5);
  addTerm(context.activeFileBasename, 4);
  if (context.selection?.text) addTerm(context.selection.text, 5);
  addTerm(context.surroundingText, 3);
  for (const heading of context.headingPath) addTerm(heading.text, 4);
  for (const tag of tags) addTerm(tag.replace(/^#/, ""), 4);

  for (const token of tokenizeForRetrieval(
    [
      query,
      context.selection?.text ?? "",
      context.headingPath.map((heading) => heading.text).join(" "),
      context.activeFileBasename,
      context.surroundingText,
    ].join("\n"),
  )) {
    addTerm(token, token.length >= 5 ? 3 : 2);
  }

  return Array.from(termWeights.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([term]) => term)
    .slice(0, 40);
}

function tokenizeForRetrieval(text: string): string[] {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase();
  const englishMatches = normalized.match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  for (const token of englishMatches) {
    if (!STOP_WORDS.has(token)) tokens.add(token);
  }

  const cjkMatches = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const phrase of cjkMatches) {
    if (phrase.length <= 6) {
      tokens.add(phrase);
      continue;
    }
    for (let index = 0; index <= phrase.length - 2; index += 1) {
      tokens.add(phrase.slice(index, index + 2));
    }
    for (let index = 0; index <= phrase.length - 4; index += 2) {
      tokens.add(phrase.slice(index, index + 4));
    }
  }

  return Array.from(tokens);
}

function scoreRelatedNote(
  file: TFile,
  content: string,
  cache: CachedMetadata | null,
  terms: string[],
  graph: {
    outlinks: string[];
    backlinks: string[];
    recentFiles: string[];
    sourceType: RelatedNote["sourceType"];
  },
): { score: number; reasons: string[] } {
  const basename = file.basename.toLowerCase();
  const lowerContent = content.toLowerCase();
  const headings = (cache?.headings ?? []).map((heading) => heading.heading.toLowerCase());
  const tags = getCacheTags(cache).map((tag) => tag.toLowerCase().replace(/^#/, ""));
  const reasons = new Set<string>();
  let score = 0;

  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (basename.includes(normalized)) {
      score += 12;
      reasons.add(`文件名命中「${term}」`);
    }
    if (headings.some((heading) => heading.includes(normalized))) {
      score += 10;
      reasons.add(`标题命中「${term}」`);
    }
    if (tags.some((tag) => tag.includes(normalized))) {
      score += 8;
      reasons.add(`标签命中「${term}」`);
    }

    const count = countOccurrences(lowerContent, normalized);
    if (count > 0) {
      score += Math.min(count, 6) * 2;
      reasons.add(`正文命中「${term}」`);
    }
  }

  if (graph.outlinks.includes(file.path) || graph.backlinks.includes(file.path)) {
    score += 10;
    reasons.add("链接关系相关");
  }
  if (graph.recentFiles.includes(file.path)) {
    score += 5;
    reasons.add("最近打开");
  }
  if (score > 0 && graph.sourceType === "questionNode") {
    score += 14;
    reasons.add("历史问题节点");
  }
  if (score > 0 && graph.sourceType === "readingTrail") {
    score += 12;
    reasons.add("阅读线索");
  }

  return {
    score,
    reasons: Array.from(reasons).slice(0, 4),
  };
}

function createRelevantExcerpt(content: string, terms: string[], maxChars: number): string {
  const normalized = content.toLowerCase();
  let bestIndex = -1;
  for (const term of terms) {
    bestIndex = normalized.indexOf(term.toLowerCase());
    if (bestIndex >= 0) break;
  }

  if (bestIndex < 0) return trimToLimit(content, maxChars);

  const start = Math.max(0, bestIndex - Math.floor(maxChars / 2));
  const end = Math.min(content.length, start + maxChars);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function countOccurrences(content: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = content.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(term, index + term.length);
  }
  return count;
}

function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[#*_`()[\]{}，。！？、；：“”‘’"'<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1]) links.add(match[1].trim());
  }
  return Array.from(links);
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "have",
  "what",
  "when",
  "where",
  "which",
  "there",
  "their",
]);

function buildCodexPrompt(
  context: ExtendedReadingContext,
  question: string,
  companionNotePath: string,
  history: ChatHistoryItem[] = [],
): string {
  const historyText = history.length
    ? history
        .map((message) => `${message.role === "user" ? "用户" : "Web"}：${message.content}`)
        .join("\n\n")
    : "无";

  return [
    "你是一个嵌入 Obsidian 的 Web 阅读 agent。Web 的目标是把用户阅读中的问题、回答、旧笔记和跨书关联织成一张知识网。底层运行时是 Codex CLI harness。",
    "",
    "目标：帮助用户理解正在阅读的材料，解释难点，提炼概念，连接上下文，并给出可写入阅读笔记和问题节点的回答。",
    "",
    "优先级：",
    "1. 优先基于当前阅读材料回答。",
    "2. 如果使用 relatedNotes，必须说明来自哪篇笔记。",
    "3. 如果是推测，明确标注“这是推测”。",
    "4. 不直接要求修改文件，只输出指定 JSON 对象。",
    "5. 回答要适合写入 Obsidian 阅读笔记。",
    "",
    "硬性约束：",
    "- 使用简体中文。",
    "- 优先基于提供的阅读上下文回答；如果需要推测，明确说这是推测。",
    "- 不要直接修改文件。当前 Codex 以 read-only sandbox 运行，插件会负责写入笔记和问题节点。",
    "- 回答要适合写入 Obsidian，不要输出营销式套话。",
    "- 如果引用原文，请保留短引用，并说明它来自当前材料的哪一部分。",
    "- relatedNotes 是只读参考，不等于事实来源；使用时要标明笔记路径。",
    "- relatedEchoes 必须来自 relatedNotes 或 Agent-Memory 片段；使用时要标明 path。",
    "- readingTrails 是用户长期阅读线索，最多给 3 条，标题要短。",
    "- proposedActions 只能从 availableActions 中选择；不要提出删除文件、自动写 Agent-Memory、自动改原书原文。",
    "- 插件会自动执行阅读笔记写入和问题节点记录；需要改原文或创建概念卡片时，只能提出 proposedActions，等待用户确认。",
    "",
    "动作协议：",
    "- appendReadingNote: 插件默认自动执行。",
    "- insertAnswerCallout: 需要确认后执行。",
    "- createConceptNote: 需要确认后执行。",
    "- openRelatedNote: 可建议打开相关笔记。",
    "",
    "输出格式：",
    "只输出一个 JSON 对象，不要 Markdown 代码块，不要在 JSON 外输出任何文字。字段如下：",
    "{",
    '  "answer": "直接解释用户当下卡住的问题，适合写入阅读笔记",',
    '  "currentMaterial": "说明回答如何来自当前材料；没有则为空字符串",',
    '  "relatedEchoes": [',
    '    {"path": "相关笔记路径", "relation": "它和当前问题的关系", "excerpt": "短摘录"}',
    "  ],",
    '  "conceptLinks": [',
    '    {"label": "概念名", "relation": "概念关系", "sourcePath": "来源路径", "excerpt": "短摘录", "confidence": 0.7}',
    "  ],",
    '  "readingTrails": [',
    '    {"title": "阅读线索名", "reason": "为什么这个问题属于这条线索", "relatedPaths": ["路径"]}',
    "  ],",
    '  "proposedActions": []',
    "}",
    "",
    `允许写入的阅读笔记目标：${companionNotePath}`,
    "",
    "最近对话：",
    historyText,
    "",
    "用户问题：",
    question.trim(),
    "",
    "阅读上下文 JSON：",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
  ].join("\n");
}

function parseCodexStructuredResponse(rawAnswer: string): CodexStructuredResponse | null {
  const jsonText = extractJsonObject(rawAnswer);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;

    const answer = firstString(record, ["answer", "回答", "content"]).trim();
    if (!answer) return null;

    return {
      answer,
      currentMaterial: firstString(record, ["currentMaterial", "current_material", "当前材料依据"]),
      relatedEchoes: normalizeRelatedEchoes(record.relatedEchoes ?? record.related_echoes),
      conceptLinks: normalizeConceptLinks(record.conceptLinks ?? record.concept_links),
      readingTrails: normalizeReadingTrails(record.readingTrails ?? record.reading_trails),
      proposedActions: normalizeNoteActions(record.proposedActions ?? record.proposed_actions),
    };
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string | null {
  const trimmed = value.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normalizeRelatedEchoes(value: unknown): RelatedEcho[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): RelatedEcho | null => {
      const record = asRecord(item);
      if (!record) return null;
      const path = firstString(record, ["path", "sourcePath", "source", "来源"]);
      const relation = firstString(record, ["relation", "reason", "note", "关联"]);
      if (!path && !relation) return null;
      return {
        path: path || "未标明来源",
        relation: relation || "相关但未说明关系",
        excerpt: firstString(record, ["excerpt", "quote", "引用"]),
      };
    })
    .filter((item): item is RelatedEcho => item !== null)
    .slice(0, 6);
}

function normalizeConceptLinks(value: unknown): ConceptLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): ConceptLink | null => {
      const record = asRecord(item);
      if (!record) return null;
      const label = firstString(record, ["label", "concept", "title", "概念"]);
      const relation = firstString(record, ["relation", "reason", "关联"]);
      if (!label && !relation) return null;
      const confidence = Number(record.confidence);
      return {
        label: label || "未命名概念",
        relation: relation || "相关但未说明关系",
        sourcePath: firstString(record, ["sourcePath", "path", "source"]),
        excerpt: firstString(record, ["excerpt", "quote"]),
        confidence: Number.isFinite(confidence) ? confidence : undefined,
      };
    })
    .filter((item): item is ConceptLink => item !== null)
    .slice(0, 8);
}

function normalizeReadingTrails(value: unknown): ReadingTrail[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const title = firstString(record, ["title", "name", "线索"]);
      const reason = firstString(record, ["reason", "relation", "说明"]);
      if (!title && !reason) return null;
      const relatedPathsValue = record.relatedPaths ?? record.related_paths;
      return {
        title: title || "未命名线索",
        reason: reason || "相关但未说明原因",
        relatedPaths: Array.isArray(relatedPathsValue)
          ? relatedPathsValue.filter((path): path is string => typeof path === "string")
          : [],
      };
    })
    .filter((item): item is ReadingTrail => item !== null)
    .slice(0, 3);
}

function normalizeNoteActions(value: unknown): NoteAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const type = typeof record?.type === "string" ? record.type : "";
      if (type === "appendReadingNote" && typeof record?.targetPath === "string") {
        return {
          type,
          targetPath: record.targetPath,
          content: firstString(record, ["content"]),
        } satisfies NoteAction;
      }
      if (type === "insertAnswerCallout" && typeof record?.blockId === "string") {
        return {
          type,
          blockId: record.blockId,
          content: firstString(record, ["content"]),
        } satisfies NoteAction;
      }
      if (type === "createConceptNote" && typeof record?.title === "string") {
        return {
          type,
          title: record.title,
          content: firstString(record, ["content"]),
          needsConfirm: true,
        } satisfies NoteAction;
      }
      if (type === "openRelatedNote" && typeof record?.path === "string") {
        return {
          type,
          path: record.path,
        } satisfies NoteAction;
      }
      return null;
    })
    .filter((item): item is NoteAction => item !== null);
}

function createFallbackStructuredResponse(answer: string): CodexStructuredResponse {
  return {
    answer,
    relatedEchoes: [],
    conceptLinks: [],
    readingTrails: [],
    proposedActions: [],
  };
}

function formatAnswerForReadingNote(result: CodexRunResult): string {
  const response = result.structuredResponse;
  if (!response) return result.answer.trim();
  return formatStructuredAnswer(response);
}

function formatStructuredAnswer(response: CodexStructuredResponse): string {
  const parts = [
    response.answer.trim(),
    response.currentMaterial?.trim()
      ? `\n### 当前材料依据\n\n${response.currentMaterial.trim()}`
      : "",
    response.relatedEchoes.length
      ? `\n### 其他笔记/书里的回声\n\n${response.relatedEchoes
          .map((echo) => `- ${echo.path}：${echo.relation}${echo.excerpt ? `\n  > ${echo.excerpt}` : ""}`)
          .join("\n")}`
      : "",
    response.conceptLinks.length
      ? `\n### 概念关联\n\n${response.conceptLinks
          .map((link) => `- ${link.label}：${link.relation}${link.sourcePath ? `（${link.sourcePath}）` : ""}`)
          .join("\n")}`
      : "",
    response.readingTrails.length
      ? `\n### 阅读线索\n\n${response.readingTrails
          .map((trail) => `- ${trail.title}：${trail.reason}`)
          .join("\n")}`
      : "",
  ];
  return parts.filter(Boolean).join("\n");
}

function formatQuestionNodeMarkdown(
  context: ExtendedReadingContext,
  question: string,
  response: CodexStructuredResponse,
  createdAt: Date,
): string {
  const headingText = context.headingPath.map((heading) => heading.text).join(" / ") || "无";
  const sourceLink = formatWikiLink(context.activeFilePath, context.activeFileName);
  const concepts = extractConceptLabels(response);
  const trails = response.readingTrails.map((trail) => trail.title).filter(Boolean);
  const selection = context.selection?.text.trim();
  const title = trimToLimit(question.replace(/\s+/g, " "), 80);

  return [
    "---",
    `created: ${createdAt.toISOString()}`,
    `source: ${JSON.stringify(context.activeFilePath)}`,
    `line: ${context.cursorLine}`,
    `concepts: ${JSON.stringify(concepts)}`,
    `trails: ${JSON.stringify(trails)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 阅读现场",
    "",
    `- 来源：${sourceLink}`,
    `- 位置：第 ${context.cursorLine} 行`,
    `- 标题路径：${headingText}`,
    selection ? "" : null,
    selection ? "**选区**" : null,
    selection ? "" : null,
    selection ? blockquoteMarkdown(selection) : null,
    "",
    "## 问题",
    "",
    question.trim(),
    "",
    "## 回答",
    "",
    formatStructuredAnswer(response),
    "",
    "## 检索命中",
    "",
    context.relatedNotes.length
      ? context.relatedNotes
          .map((note) => `- ${formatWikiLink(note.path)}：${note.reason}（${note.sourceType}，${note.score}）`)
          .join("\n")
      : "无",
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatReadingTrailEntry(
  trail: ReadingTrail,
  questionNodePath: string,
  context: ExtendedReadingContext,
  question: string,
  response: CodexStructuredResponse,
  createdAt: Date,
): string {
  const concepts = extractConceptLabels(response).join("、") || "无";
  return [
    `### ${formatLocalDateTime(createdAt)}`,
    "",
    `- 问题节点：${formatWikiLink(questionNodePath, trimToLimit(question.replace(/\s+/g, " "), 42))}`,
    `- 来源：${formatWikiLink(context.activeFilePath, context.activeFileName)}，第 ${context.cursorLine} 行`,
    `- 关联原因：${trail.reason}`,
    `- 概念：${concepts}`,
    "",
  ].join("\n");
}

function extractConceptLabels(response: CodexStructuredResponse): string[] {
  return Array.from(
    new Set([
      ...response.conceptLinks.map((link) => link.label.trim()).filter(Boolean),
      ...response.readingTrails.map((trail) => trail.title.trim()).filter(Boolean),
    ]),
  ).slice(0, 12);
}

function formatWikiLink(path: string, alias?: string): string {
  const target = normalizePath(path).replace(/\.md$/, "");
  const safeAlias = alias?.replace(/[\]\|]/g, "/").trim();
  return safeAlias ? `[[${target}|${safeAlias}]]` : `[[${target}]]`;
}

function blockquoteMarkdown(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function createSlug(value: string, maxLength: number): string {
  const slug = sanitizeFileName(value)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "question";
}

function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatDateForPath(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

function getSurroundingText(
  lines: string[],
  cursorLine: number,
  radiusLines: number,
  maxChars: number,
): string {
  const halfRadius = Math.max(5, Math.floor(radiusLines / 2));
  const start = Math.max(0, cursorLine - halfRadius);
  const end = Math.min(lines.length, cursorLine + halfRadius + 1);
  return trimToLimit(lines.slice(start, end).join("\n"), maxChars);
}

function buildFileExcerpt(content: string, cursorLine: number, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split(/\r?\n/);
  return getSurroundingText(lines, cursorLine, Math.max(80, Math.floor(lines.length / 4)), maxChars);
}

function getOutline(lines: string[]): HeadingItem[] {
  return lines
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (!match) return null;
      return {
        level: match[1].length,
        text: match[2].trim(),
        line: index + 1,
      };
    })
    .filter((heading): heading is HeadingItem => heading !== null)
    .slice(0, 80);
}

function getHeadingPath(lines: string[], cursorLine: number): HeadingItem[] {
  const stack: HeadingItem[] = [];
  for (let index = 0; index <= cursorLine && index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (!match) continue;
    const heading = {
      level: match[1].length,
      text: match[2].trim(),
      line: index + 1,
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
  }
  return stack;
}

function findQuestionBlockAtCursor(editor: Editor): CodexQuestionBlock | null {
  const lines = editor.getValue().split(/\r?\n/);
  const cursorLine = editor.getCursor().line;
  let startLine = -1;

  for (let line = Math.min(cursorLine, lines.length - 1); line >= 0; line -= 1) {
    if (isQuestionCalloutHeader(lines[line])) {
      startLine = line;
      break;
    }
    if (line !== cursorLine && isAnyCalloutHeader(lines[line])) {
      break;
    }
  }

  if (startLine < 0) return null;

  const endLine = findQuestionCalloutEnd(lines, startLine);
  if (cursorLine > endLine) return null;

  const blockLines = lines.slice(startLine + 1, endLine + 1);
  const blockId = findQuestionBlockId(blockLines);
  const question = blockLines
    .map(stripCalloutPrefix)
    .filter((line) => !isBlockIdLine(line))
    .join("\n")
    .trim();
  const answerStartLine = findNextAnswerStart(lines, endLine + 1);
  const answerEndLine = answerStartLine === null ? null : findGenericCalloutEnd(lines, answerStartLine);

  return {
    startLine,
    endLine,
    question,
    blockId,
    answerStartLine,
    answerEndLine,
  };
}

function insertQuestionBlockId(
  editor: Editor,
  block: CodexQuestionBlock,
  blockId: string,
): CodexQuestionBlock {
  const insertLine = block.endLine + 1;
  editor.replaceRange(`> ^${blockId}\n`, { line: insertLine, ch: 0 });

  return {
    ...block,
    blockId,
    endLine: block.endLine + 1,
    answerStartLine: block.answerStartLine === null ? null : block.answerStartLine + 1,
    answerEndLine: block.answerEndLine === null ? null : block.answerEndLine + 1,
  };
}

function replaceAnswerCallout(
  editor: Editor,
  block: CodexQuestionBlock,
  answer: string,
): CodexQuestionBlock {
  const answerCallout = formatAnswerCallout(answer);

  if (block.answerStartLine !== null && block.answerEndLine !== null) {
    editor.replaceRange(
      answerCallout,
      { line: block.answerStartLine, ch: 0 },
      { line: block.answerEndLine + 1, ch: 0 },
    );
    const answerLineCount = answerCallout.split(/\r?\n/).filter((line, index, list) => {
      return index < list.length - 1 || line.length > 0;
    }).length;
    return {
      ...block,
      answerEndLine: block.answerStartLine + answerLineCount - 1,
    };
  }

  const insertLine = block.endLine + 1;
  editor.replaceRange(`\n${answerCallout}`, { line: insertLine, ch: 0 });
  const answerLineCount = answerCallout.split(/\r?\n/).filter((line, index, list) => {
    return index < list.length - 1 || line.length > 0;
  }).length;

  return {
    ...block,
    answerStartLine: insertLine + 1,
    answerEndLine: insertLine + answerLineCount,
  };
}

function formatAnswerCallout(answer: string): string {
  const body = answer.trim() || "Web 没有返回内容。";
  return [
    "> [!answer]- Web 回答",
    ...body.split(/\r?\n/).map((line) => `> ${line}`),
    "",
  ].join("\n");
}

function findQuestionCalloutEnd(lines: string[], startLine: number): number {
  let endLine = startLine;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    if (isAnswerCalloutHeader(lines[line])) break;
    if (isAnyCalloutHeader(lines[line])) break;
    if (!isCalloutLine(lines[line])) break;
    endLine = line;
  }
  return endLine;
}

function findGenericCalloutEnd(lines: string[], startLine: number): number {
  let endLine = startLine;
  for (let line = startLine + 1; line < lines.length; line += 1) {
    if (isAnyCalloutHeader(lines[line])) break;
    if (!isCalloutLine(lines[line])) break;
    endLine = line;
  }
  return endLine;
}

function findNextAnswerStart(lines: string[], fromLine: number): number | null {
  for (let line = fromLine; line < lines.length; line += 1) {
    if (!lines[line].trim()) continue;
    return isAnswerCalloutHeader(lines[line]) ? line : null;
  }
  return null;
}

function findQuestionBlockId(lines: string[]): string | null {
  for (const line of lines) {
    const match = /^\^([A-Za-z0-9_-]+)$/.exec(stripCalloutPrefix(line).trim());
    if (match?.[1]?.startsWith("web-q-") || match?.[1]?.startsWith("codex-q-")) return match[1];
  }
  return null;
}

function isQuestionCalloutHeader(line: string): boolean {
  return /^>\s*\[!question\][+-]?\s*(?:(?:Codex|Web)\s*提问)?/i.test(line.trim());
}

function isAnswerCalloutHeader(line: string): boolean {
  return /^>\s*\[!answer\][+-]?\s*(?:(?:Codex|Web)\s*回答)?/i.test(line.trim());
}

function isAnyCalloutHeader(line: string): boolean {
  return /^>\s*\[![^\]]+\][+-]?/.test(line.trim());
}

function isCalloutLine(line: string): boolean {
  return /^>\s?/.test(line);
}

function stripCalloutPrefix(line: string): string {
  return line.replace(/^>\s?/, "");
}

function isBlockIdLine(line: string): boolean {
  return /^\s*\^[A-Za-z0-9_-]+\s*$/.test(line);
}

function createQuestionBlockId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `web-q-${stamp}-${suffix}`;
}

function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCurrentDomSelectionText(): string {
  const selection = globalThis.getSelection?.();
  if (selection?.anchorNode) {
    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode.parentElement;
    if (anchorElement?.closest(".codex-reading-root")) return "";
  }
  const selectedText = selection?.toString().trim() ?? "";
  return selectedText.length > 1 ? selectedText : "";
}

function getCurrentSelectionAnchorRect(): SelectionAnchorRect | null {
  const selection = globalThis.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.toString().trim().length <= 1) return null;
  const anchorElement =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode?.parentElement;
  if (anchorElement?.closest(".codex-reading-root")) return null;

  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function cloneEditorPosition(position: EditorPosition): EditorPosition {
  return {
    line: position.line,
    ch: position.ch,
  };
}

function wrapEditorRangeWithHighlight(
  editor: Editor,
  filePath: string,
  from: EditorPosition,
  to: EditorPosition,
  rect?: SelectionAnchorRect,
): MarkedSelectionResult | null {
  const selectedText = editor.getRange(from, to);
  if (!selectedText.trim()) return null;
  if (isEditorRangeAlreadyHighlighted(editor, from, to)) {
    return {
      filePath,
      text: selectedText,
      startLine: from.line + 1,
      endLine: to.line + 1,
      rect,
    };
  }

  editor.replaceRange(`==${selectedText}==`, from, to);
  return {
    filePath,
    text: selectedText,
    startLine: from.line + 1,
    endLine: to.line + 1,
    rect,
  };
}

function isEditorRangeAlreadyHighlighted(
  editor: Editor,
  from: EditorPosition,
  to: EditorPosition,
): boolean {
  const beforeStart = {
    line: from.line,
    ch: Math.max(0, from.ch - 2),
  };
  const before = editor.getRange(beforeStart, from);
  const toLineLength = editor.getLine(to.line)?.length ?? to.ch;
  const after = editor.getRange(to, {
    line: to.line,
    ch: Math.min(toLineLength, to.ch + 2),
  });
  return before.endsWith("==") && after.startsWith("==");
}

function isContentRangeAlreadyHighlighted(content: string, start: number, end: number): boolean {
  return content.slice(Math.max(0, start - 2), start) === "==" && content.slice(end, end + 2) === "==";
}

function findSelectionRangeInContent(
  content: string,
  selectedText: string,
  cursorLine: number,
): { start: number; end: number } | null {
  const exactMatches = findAllExactRanges(content, selectedText);
  if (exactMatches.length > 0) {
    return chooseClosestRangeToLine(content, exactMatches, cursorLine);
  }

  const normalizedRange = findNormalizedSelectionRange(content, selectedText);
  if (!normalizedRange) return null;
  return normalizedRange;
}

function findAllExactRanges(content: string, selectedText: string): Array<{ start: number; end: number }> {
  const needle = selectedText.trim();
  if (!needle) return [];

  const matches: Array<{ start: number; end: number }> = [];
  let fromIndex = 0;
  while (fromIndex < content.length) {
    const matchIndex = content.indexOf(needle, fromIndex);
    if (matchIndex < 0) break;
    matches.push({ start: matchIndex, end: matchIndex + needle.length });
    fromIndex = matchIndex + needle.length;
  }
  return matches;
}

function chooseClosestRangeToLine(
  content: string,
  ranges: Array<{ start: number; end: number }>,
  cursorLine: number,
): { start: number; end: number } {
  return ranges
    .slice()
    .sort((left, right) => {
      const leftDistance = Math.abs(getLineNumberAtOffset(content, left.start) - cursorLine);
      const rightDistance = Math.abs(getLineNumberAtOffset(content, right.start) - cursorLine);
      return leftDistance - rightDistance;
    })[0];
}

function findNormalizedSelectionRange(
  content: string,
  selectedText: string,
): { start: number; end: number } | null {
  const normalizedNeedle = selectedText.replace(/\s+/g, " ").trim();
  if (!normalizedNeedle) return null;

  const normalizedChars: string[] = [];
  const sourceOffsets: number[] = [];
  let previousWasSpace = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (/\s/.test(char)) {
      if (!previousWasSpace) {
        normalizedChars.push(" ");
        sourceOffsets.push(index);
        previousWasSpace = true;
      }
      continue;
    }

    normalizedChars.push(char);
    sourceOffsets.push(index);
    previousWasSpace = false;
  }

  const normalizedContent = normalizedChars.join("").trim();
  const leadingTrimmedLength = normalizedChars.join("").length - normalizedChars.join("").trimStart().length;
  const normalizedIndex = normalizedContent.indexOf(normalizedNeedle);
  if (normalizedIndex < 0) return null;

  const startNormalizedIndex = normalizedIndex + leadingTrimmedLength;
  const endNormalizedIndex = startNormalizedIndex + normalizedNeedle.length - 1;
  const start = sourceOffsets[startNormalizedIndex];
  const end = (sourceOffsets[endNormalizedIndex] ?? start) + 1;
  return start === undefined ? null : { start, end };
}

function getLineNumberAtOffset(content: string, offset: number): number {
  return content.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
}

function isSameLooseText(left: string, right: string): boolean {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function looksLikePath(command: string): boolean {
  return command.startsWith("/") || command.includes("/");
}

function buildChildPath(commands: string[], currentPath?: string): string {
  const seedPaths = [
    ...commands.filter(looksLikePath).map(dirname),
    "/Users/andreas/.local/bin",
    "/Users/andreas/.bun/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    currentPath ?? "",
  ];
  const parts = seedPaths.flatMap((entry) => entry.split(":")).filter(Boolean);
  return Array.from(new Set(parts)).join(":");
}

function extractCodexDelta(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const type = getEventType(record).toLowerCase();
  if (!type.includes("delta")) return "";

  const direct = firstString(record, ["delta", "text", "content"]);
  if (direct) return direct;

  const item = asRecord(record.item) ?? asRecord(record.msg) ?? asRecord(record.message);
  return item ? firstString(item, ["delta", "text", "content"]) : "";
}

function extractAssistantMessageText(event: unknown): string {
  const record = asRecord(event);
  if (!record) return "";
  const item = asRecord(record.item) ?? asRecord(record.msg) ?? asRecord(record.message) ?? record;
  const role = typeof item.role === "string" ? item.role : typeof record.role === "string" ? record.role : "";
  const type = getEventType(record).toLowerCase();
  const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";

  if (role && role !== "assistant") return "";
  if (!role && !type.includes("message") && !itemType.includes("message")) return "";

  const contentText = extractContentText(item.content);
  if (contentText) return contentText;

  return firstString(item, ["answer", "message", "text", "content"]);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record) return "";
      return firstString(record, ["text", "content", "output_text"]);
    })
    .filter(Boolean)
    .join("");
}

function selectBestAssistantText(events: unknown[]): string {
  return selectBestText(events.map(extractAssistantMessageText).filter(Boolean));
}

function selectBestText(values: string[]): string {
  return values.reduce((best, current) => (current.length > best.length ? current : best), "");
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function getEventType(record: Record<string, unknown>): string {
  if (typeof record.type === "string") return record.type;
  const msg = asRecord(record.msg);
  if (typeof msg?.type === "string") return msg.type;
  const item = asRecord(record.item);
  if (typeof item?.type === "string") return item.type;
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimToLimit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[已截断，原始长度 ${value.length} 字符]`;
}

function formatLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
