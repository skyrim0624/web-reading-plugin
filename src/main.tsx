import {
  App,
  CachedMetadata,
  Editor,
  EditorPosition,
  FileSystemAdapter,
  ItemView,
  MarkdownFileInfo,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  addIcon,
  normalizePath,
} from "obsidian";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { dirname } from "path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Root, createRoot } from "react-dom/client";

const VIEW_TYPE_CODEX_READING = "web-reading-plugin-view";
const PLUGIN_DISPLAY_NAME = "think anytime";
const PLUGIN_ICON_ID = "think-anytime";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const CODEX_MODEL_OPTIONS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as const;
const MAX_STORED_CONVERSATIONS = 18;
const MAX_STORED_MESSAGES = 24;
const IMMERSIVE_BODY_CLASS = "think-anytime-immersive";
const IMMERSIVE_EXIT_BUTTON_CLASS = "think-anytime-immersive-exit";
const THINK_ANYTIME_ICON_SVG = `
<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="128" height="128" rx="18" fill="#050505"/>
  <path fill="#ffffff" d="M38.2 25.7c9.1-8.9 23-8.3 30.9-1.6 7.9-3 17.8-.8 23.2 6.7 4.8 6.7 4.3 15.7-.5 22.1 5.8 3.8 9.4 10.4 9.4 17.7 0 11.9-9.7 21.5-21.6 21.5-1.8 0-3.5-.2-5.1-.6-3.7 8-11.9 13.3-21.2 13.3-8.6 0-16.1-4.6-20.2-11.4-10.5-.8-18.8-9.6-18.8-20.3 0-6.3 2.9-12.1 7.6-15.8-3.5-11.4 3.6-24.2 16.3-31.6Z"/>
  <path fill="none" stroke="#050505" stroke-linecap="round" stroke-linejoin="round" stroke-width="7" d="M47 32l4 22-13 7m32-29-8 19 17 6m-33 15 19-2-7 22m-17-1 11-13m21-5 17 11m-26-18 8-15"/>
</svg>
`.trim();

interface CodexReadingSettings {
  nodeCommand: string;
  codexCommand: string;
  defaultModel: string;
  defaultReasoningPreset: CodexReasoningPreset;
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

type ReadingSourceType = "markdown" | "pdf" | "epub";
type CodexResponseMode = "fast" | "deep";
type CodexReasoningPreset = "fast" | "xhigh";
type CodexModelReasoningEffort = "low" | "xhigh";

interface BuildReadingContextOptions {
  responseMode?: CodexResponseMode;
  forceVaultRetrieval?: boolean;
}

interface AskCodexOptions extends BuildReadingContextOptions {
  model?: string;
  reasoningPreset?: CodexReasoningPreset;
  abortSignal?: AbortSignal;
}

interface ReadingSelection {
  text: string;
  startLine: number;
  endLine: number;
  locationLabel?: string;
  pageNumber?: number;
  chapterTitle?: string;
}

interface SelectionSnapshot {
  filePath: string;
  text: string;
  from?: EditorPosition;
  to?: EditorPosition;
  locationLabel?: string;
  pageNumber?: number;
  capturedAt: number;
}

interface MarkedSelectionResult {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  anchorId: string;
}

interface HeadingItem {
  level: number;
  text: string;
  line: number;
}

interface ReadingContext {
  sourceType: ReadingSourceType;
  vaultName: string;
  vaultPath: string;
  activeFilePath: string;
  activeFileName: string;
  activeFileBasename: string;
  cursorLine: number;
  locationLabel: string;
  pageNumber?: number;
  totalPages?: number;
  chapterTitle?: string;
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

interface StoredReadingMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface StoredReadingConversation {
  id: string;
  sessionId: string;
  title: string;
  sourcePath: string;
  sourceName?: string;
  locationLabel?: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  reasoningPreset: CodexReasoningPreset;
  forceVaultRetrieval: boolean;
  messages: StoredReadingMessage[];
}

interface PluginStoredData extends Partial<CodexReadingSettings> {
  conversationHistory?: unknown;
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

interface CodexQuestionBlock {
  startLine: number;
  endLine: number;
  question: string;
  blockId: string | null;
  answerStartLine: number | null;
  answerEndLine: number | null;
}

interface ExtractedTextBlock {
  text: string;
  lineStart: number;
  lineEnd: number;
  locationLabel: string;
  pageNumber?: number;
  chapterTitle?: string;
}

interface ExtractedReadingDocument {
  sourceType: Exclude<ReadingSourceType, "markdown">;
  text: string;
  outline: HeadingItem[];
  blocks: ExtractedTextBlock[];
  totalPages?: number;
}

interface DocumentExtractionCacheEntry {
  key: string;
  document?: ExtractedReadingDocument;
  promise?: Promise<ExtractedReadingDocument>;
}

interface DomSelectionSnapshot {
  text: string;
  locationLabel?: string;
  pageNumber?: number;
}

interface TextExtractorApi {
  extractText: (file: TFile) => Promise<string>;
  canFileBeExtracted: (filePath: string) => boolean;
  isInCache?: (file: TFile) => Promise<boolean>;
}

interface PdfJsModule {
  getDocument: (src: PdfDocumentInitParameters) => PdfDocumentLoadingTask;
  GlobalWorkerOptions?: {
    workerSrc?: string;
  };
  version?: string;
}

interface PdfDocumentInitParameters {
  data: Uint8Array;
  useWorkerFetch?: boolean;
  isEvalSupported?: boolean;
  disableFontFace?: boolean;
  useSystemFonts?: boolean;
}

interface PdfDocumentLoadingTask {
  promise: Promise<PdfDocumentProxy>;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void> | void;
}

interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>;
}

interface PdfTextContent {
  items: unknown[];
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

const DEFAULT_SETTINGS: CodexReadingSettings = {
  nodeCommand: "/Users/andreas/.local/bin/node",
  codexCommand: "/Users/andreas/.bun/bin/codex",
  defaultModel: DEFAULT_CODEX_MODEL,
  defaultReasoningPreset: "fast",
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
  private conversationHistory: StoredReadingConversation[] = [];
  private lastMarkedText = "";
  private lastSelectionSnapshot: SelectionSnapshot | null = null;
  private lastReadingFilePath: string | null = null;
  private highlightPopover: HTMLElement | null = null;
  private immersiveExitButton: HTMLButtonElement | null = null;
  private readonly selectionFrameDocuments = new WeakSet<Document>();
  private readonly documentExtractionCache = new Map<string, DocumentExtractionCacheEntry>();

  async onload() {
    await this.loadSettings();
    addIcon(PLUGIN_ICON_ID, THINK_ANYTIME_ICON_SVG);

    this.registerView(
      VIEW_TYPE_CODEX_READING,
      (leaf) => new CodexReadingView(leaf, this),
    );

    this.addRibbonIcon(PLUGIN_ICON_ID, `打开 ${PLUGIN_DISPLAY_NAME}`, () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-web-reading-view",
      name: `打开 ${PLUGIN_DISPLAY_NAME} 面板`,
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
      id: "toggle-think-anytime-immersive",
      name: `切换 ${PLUGIN_DISPLAY_NAME} 沉浸式阅读`,
      callback: () => {
        this.toggleImmersiveMode();
      },
    });

    this.addCommand({
      id: "insert-web-question-callout",
      name: `插入 ${PLUGIN_DISPLAY_NAME} 问题块`,
      editorCallback: (editor) => {
        this.insertQuestionCallout(editor);
      },
    });

    this.addCommand({
      id: "answer-current-web-question-callout",
      name: `回答当前 ${PLUGIN_DISPLAY_NAME} 问题块`,
      editorCallback: (editor, ctx) => {
        void this.answerCurrentQuestionCallout(editor, ctx);
      },
    });

    this.registerDomEvent(document, "selectionchange", () => {
      this.captureSelectionSnapshot();
    });
    this.registerDomEvent(document, "mouseup", () => {
      window.setTimeout(() => this.captureSelectionSnapshot(), 0);
    });
    this.registerDomEvent(document, "keyup", () => {
      window.setTimeout(() => this.captureSelectionSnapshot(), 0);
    });
    this.registerDomEvent(document, "click", (event) => {
      void this.handleHighlightNoteClick(event);
    });
    this.registerSelectionListenersInFrames();
    this.registerInterval(
      window.setInterval(() => this.registerSelectionListenersInFrames(), 2000),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && getReadingSourceType(file)) {
          this.lastReadingFilePath = file.path;
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const file = leaf ? getReadingFileFromLeaf(leaf) : null;
        if (file) {
          this.lastReadingFilePath = file.path;
        }
      }),
    );

    this.addSettingTab(new CodexReadingSettingTab(this.app, this));
  }

  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX_READING)) {
      leaf.detach();
    }
    this.closeHighlightPopover();
    this.disableImmersiveMode(false);
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

  toggleImmersiveMode(force?: boolean) {
    const shouldEnable = force ?? !this.isImmersiveModeEnabled();
    if (shouldEnable) {
      this.enableImmersiveMode();
      return;
    }
    this.disableImmersiveMode();
  }

  isImmersiveModeEnabled() {
    return document.body.classList.contains(IMMERSIVE_BODY_CLASS);
  }

  private enableImmersiveMode() {
    document.body.classList.add(IMMERSIVE_BODY_CLASS);
    this.ensureImmersiveExitButton();
    new Notice("已进入沉浸式阅读");
  }

  private disableImmersiveMode(showNotice = true) {
    document.body.classList.remove(IMMERSIVE_BODY_CLASS);
    this.immersiveExitButton?.remove();
    this.immersiveExitButton = null;
    if (showNotice) {
      new Notice("已退出沉浸式阅读");
    }
  }

  private ensureImmersiveExitButton() {
    if (this.immersiveExitButton?.isConnected) return;

    const button = document.createElement("button");
    button.className = IMMERSIVE_EXIT_BUTTON_CLASS;
    button.type = "button";
    button.textContent = "退出沉浸";
    button.setAttribute("aria-label", `退出 ${PLUGIN_DISPLAY_NAME} 沉浸式阅读`);
    button.addEventListener("click", () => this.toggleImmersiveMode(false));
    document.body.appendChild(button);
    this.immersiveExitButton = button;
  }

  async loadSettings() {
    const data = ((await this.loadData()) ?? {}) as PluginStoredData;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
    };
    this.settings.defaultModel = normalizeCodexModel(this.settings.defaultModel);
    this.settings.defaultReasoningPreset = normalizeReasoningPreset(
      this.settings.defaultReasoningPreset,
    );
    this.conversationHistory = normalizeStoredReadingConversations(data.conversationHistory);
  }

  async saveSettings() {
    await this.savePluginData();
  }

  getConversationHistory(): StoredReadingConversation[] {
    return this.conversationHistory.slice();
  }

  async upsertConversationSnapshot(conversation: StoredReadingConversation): Promise<void> {
    this.conversationHistory = upsertStoredReadingConversation(
      this.conversationHistory,
      conversation,
    );
    await this.savePluginData();
  }

  async deleteConversationSnapshot(id: string): Promise<void> {
    this.conversationHistory = this.conversationHistory.filter((conversation) => conversation.id !== id);
    await this.savePluginData();
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      ...this.settings,
      conversationHistory: this.conversationHistory,
    });
  }

  async buildReadingContext(
    source?: {
      editor: Editor;
      file: TFile;
    },
    query = "",
    options: BuildReadingContextOptions = {},
  ): Promise<ExtendedReadingContext> {
    const baseContext = await this.buildBaseReadingContext(source);
    return this.enrichReadingContext(baseContext, query, options);
  }

  async buildBaseReadingContext(source?: {
    editor: Editor;
    file: TFile;
  }): Promise<ReadingContext> {
    const file = source?.file ?? this.getActiveReadingFile();

    if (!file) {
      throw new Error("请先打开一篇 Markdown、PDF 或 EPUB 文件");
    }

    const sourceType = getReadingSourceType(file);
    if (!sourceType) {
      throw new Error(`${PLUGIN_DISPLAY_NAME} 当前支持 Markdown、PDF 和 EPUB 文件`);
    }

    if (sourceType !== "markdown") {
      return this.buildExtractedDocumentReadingContext(file, sourceType);
    }

    const markdownView = source ? null : this.getReadingMarkdownView(file.path);
    const editor = source?.editor ?? markdownView?.editor;
    if (!editor) {
      throw new Error("请先打开一篇 Markdown 笔记");
    }
    const content = await this.app.vault.read(file);
    const cursor = editor.getCursor();
    const selectionSnapshot = this.getUsableSelectionSnapshot(file.path);
    const editorSelection = editor.getSelection();
    const domSelection = getCurrentDomSelectionSnapshot();
    const selectedText =
      editorSelection || domSelection?.text || selectionSnapshot?.text;
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
      sourceType,
      vaultName: this.app.vault.getName(),
      vaultPath: this.getVaultPath(),
      activeFilePath: file.path,
      activeFileName: file.name,
      activeFileBasename: file.basename,
      cursorLine: cursor.line + 1,
      locationLabel: formatLineLocation(cursor.line + 1),
      headingPath: getHeadingPath(lines, cursor.line),
      outline: getOutline(lines),
      selection,
      surroundingText,
      fileExcerpt: buildFileExcerpt(content, cursor.line, this.settings.maxContextChars),
      agentMemoryExcerpt: undefined,
      capturedAt: new Date().toISOString(),
    };
  }

  private async buildExtractedDocumentReadingContext(
    file: TFile,
    sourceType: Exclude<ReadingSourceType, "markdown">,
  ): Promise<ReadingContext> {
    const document = await this.getExtractedReadingDocument(file, sourceType);
    const selectionSnapshot = this.getUsableSelectionSnapshot(file.path);
    const domSelection = getCurrentDomSelectionSnapshot();
    const selectedText = domSelection?.text || selectionSnapshot?.text || "";
    const preferredPageNumber = domSelection?.pageNumber ?? selectionSnapshot?.pageNumber;
    const locatedSelection = selectedText
      ? locateSelectionInExtractedDocument(document, selectedText, preferredPageNumber)
      : null;
    const activeBlock = locatedSelection?.block ?? getDefaultExtractedTextBlock(document);
    const cursorLine = locatedSelection?.startLine ?? activeBlock?.lineStart ?? 1;
    const locationLabel =
      locatedSelection?.locationLabel ??
      domSelection?.locationLabel ??
      selectionSnapshot?.locationLabel ??
      activeBlock?.locationLabel ??
      "文档开头";
    const pageNumber = locatedSelection?.pageNumber ?? preferredPageNumber ?? activeBlock?.pageNumber;
    const chapterTitle = locatedSelection?.chapterTitle ?? activeBlock?.chapterTitle;
    const selection = selectedText
      ? {
          text: trimToLimit(selectedText, this.settings.maxContextChars),
          startLine: locatedSelection?.startLine ?? activeBlock?.lineStart ?? 1,
          endLine: locatedSelection?.endLine ?? activeBlock?.lineEnd ?? 1,
          locationLabel,
          pageNumber,
          chapterTitle,
        }
      : undefined;

    return {
      sourceType,
      vaultName: this.app.vault.getName(),
      vaultPath: this.getVaultPath(),
      activeFilePath: file.path,
      activeFileName: file.name,
      activeFileBasename: file.basename,
      cursorLine,
      locationLabel,
      pageNumber,
      totalPages: document.totalPages,
      chapterTitle,
      headingPath: buildExtractedHeadingPath(activeBlock),
      outline: document.outline,
      selection,
      surroundingText: buildExtractedSurroundingText(
        document,
        activeBlock,
        this.settings.maxContextChars,
      ),
      fileExcerpt: buildFileExcerpt(document.text, cursorLine - 1, this.settings.maxContextChars),
      agentMemoryExcerpt: undefined,
      capturedAt: new Date().toISOString(),
    };
  }

  private async getExtractedReadingDocument(
    file: TFile,
    sourceType: Exclude<ReadingSourceType, "markdown">,
  ): Promise<ExtractedReadingDocument> {
    const key = `${file.stat.mtime}:${file.stat.size}`;
    const cached = this.documentExtractionCache.get(file.path);
    if (cached?.key === key) {
      if (cached.document) return cached.document;
      if (cached.promise) return cached.promise;
    }

    const promise = this.extractReadingDocument(file, sourceType)
      .then((document) => {
        this.documentExtractionCache.set(file.path, { key, document });
        return document;
      })
      .catch((error) => {
        this.documentExtractionCache.delete(file.path);
        throw error;
      });

    this.documentExtractionCache.set(file.path, { key, promise });
    return promise;
  }

  private async extractReadingDocument(
    file: TFile,
    sourceType: Exclude<ReadingSourceType, "markdown">,
  ): Promise<ExtractedReadingDocument> {
    const data = await this.app.vault.readBinary(file);
    if (sourceType === "pdf") {
      return extractPdfReadingDocument(file, data, getTextExtractor(this.app));
    }
    return extractEpubReadingDocument(file, data);
  }

  async markActiveSelection(context: ReadingContext): Promise<MarkedSelectionResult | null> {
    if (!context.selection?.text.trim()) return null;
    if (context.sourceType !== "markdown") return null;

    const markdownView = this.getReadingMarkdownView(context.activeFilePath);
    const file = markdownView?.file;
    const editor = markdownView?.editor;
    if (!file || !editor || file.path !== context.activeFilePath) return null;

    const snapshot = this.getUsableSelectionSnapshot(file.path);
    const editorSelection = editor.getSelection();

    if (editorSelection.trim()) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      const result = wrapEditorRangeWithHighlight(editor, file.path, from, to);
      if (result) return result;
    }

    if (snapshot?.from && snapshot.to) {
      const selectedRange = editor.getRange(snapshot.from, snapshot.to);
      if (isSameLooseText(selectedRange, context.selection.text)) {
        const result = wrapEditorRangeWithHighlight(editor, file.path, snapshot.from, snapshot.to);
        if (result) return result;
      }
    }

    return this.markSelectionByTextSearch(file, context);
  }

  async enrichReadingContext(
    context: ReadingContext,
    query = "",
    options: BuildReadingContextOptions = {},
  ): Promise<ExtendedReadingContext> {
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
    const shouldRetrieve =
      this.settings.enableVaultRetrieval &&
      (options.forceVaultRetrieval === true || options.responseMode === "deep");
    const relatedNotes = shouldRetrieve
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
      availableActions: getAvailableActions(this.settings, context.sourceType),
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
    options: AskCodexOptions = {},
    onToken?: (token: string) => void,
  ): Promise<CodexRunResult> {
    const prompt = buildCodexPrompt(
      context,
      question,
      this.getCompanionNotePath(context),
      history,
      options,
    );
    const result = await this.runCodex(prompt, context.vaultPath, options, onToken);
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

    const sourceLink = formatWikiLink(context.activeFilePath, context.activeFileName);
    const selectedBlock = context.selection
      ? `\n**选区**\n\n> ${context.selection.text.replace(/\n/g, "\n> ")}\n`
      : "";
    const headingText = context.headingPath.map((heading) => heading.text).join(" / ") || "无";
    const entry = [
      "",
      `## ${formatLocalDateTime(new Date())} 精读记录`,
      "",
      `**来源**: ${sourceLink}`,
      `**位置**: ${formatContextLocation(context)}`,
      `**标题路径**: ${headingText}`,
      blockId ? `**问题锚点**: ^${blockId}` : null,
      selectedBlock,
      "**问题**",
      "",
      question.trim(),
      "",
      `**${PLUGIN_DISPLAY_NAME} 回答**`,
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
      `  - 来源：${sourceLink}，${formatContextLocation(context)}`,
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
        `这里自动记录 ${PLUGIN_DISPLAY_NAME} 在阅读中沉淀的问题节点，方便后续跨章节、跨书检索。`,
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
          `这是一条由 ${PLUGIN_DISPLAY_NAME} 自动维护的阅读线索，用来连接不同材料里的相似问题、概念和解释路径。`,
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
    options: AskCodexOptions = {},
    onToken?: (token: string) => void,
  ): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const model = normalizeCodexModel(options.model ?? this.settings.defaultModel);
      const reasoningEffort = getModelReasoningEffort(
        normalizeReasoningPreset(options.reasoningPreset ?? this.settings.defaultReasoningPreset),
      );
      const args = [
        "exec",
        "--json",
        "--model",
        model,
        "--config",
        `model_reasoning_effort="${reasoningEffort}"`,
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
      let aborted = false;
      const abortHandler = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      const cleanupAbortListener = () => {
        options.abortSignal?.removeEventListener("abort", abortHandler);
      };

      if (options.abortSignal?.aborted) {
        child.kill("SIGTERM");
        reject(new Error("已停止等待当前回答。"));
        return;
      }
      options.abortSignal?.addEventListener("abort", abortHandler, { once: true });

      child.on("error", (error) => {
        settled = true;
        cleanupAbortListener();
        reject(
          aborted
            ? new Error("已停止等待当前回答。")
            : new Error(`无法启动 Codex CLI：${error.message}`),
        );
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
        cleanupAbortListener();
        if (aborted) {
          reject(new Error("已停止等待当前回答；如果 Codex 稍后返回，本窗口会忽略那次结果。"));
          return;
        }
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
      `> [!question]- ${PLUGIN_DISPLAY_NAME} 提问`,
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
    new Notice(`已插入 ${PLUGIN_DISPLAY_NAME} 问题块`);
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
      new Notice(`请把光标放在 ${PLUGIN_DISPLAY_NAME} 问题块里`);
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

    new Notice(`${PLUGIN_DISPLAY_NAME} 正在回答当前问题块...`);

    try {
      const context = await this.buildReadingContext({ editor, file }, workingBlock.question, {
        responseMode: "deep",
        forceVaultRetrieval: true,
      });
      const result = await this.askCodex(
        context,
        [
          `这是用户在 Obsidian 正文中标注的 ${PLUGIN_DISPLAY_NAME} 问题块。`,
          "",
          "请回答这个问题，并让回答适合直接写回该问题块下方的折叠回答 callout。",
          "",
          workingBlock.question,
        ].join("\n"),
        [],
        {
          model: this.settings.defaultModel,
          reasoningPreset: "xhigh",
          responseMode: "deep",
          forceVaultRetrieval: true,
        },
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
      new Notice(`已写回 ${PLUGIN_DISPLAY_NAME} 回答并记录问题节点`);
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: buildChildPath([nodeCommand, codexCommand], process.env.PATH),
    };
    // NOTE: Obsidian 可能继承旧的 OPENAI_API_KEY，Codex 会优先用它并触发 401；这里改走 Codex 登录态。
    delete env.OPENAI_API_KEY;

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
      throw new Error(`无法获取 vault 本地路径；${PLUGIN_DISPLAY_NAME} 目前只支持桌面端本地 vault`);
    }
    return basePath;
  }

  private getActiveReadingFile(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && getReadingSourceType(activeFile)) {
      this.lastReadingFilePath = activeFile.path;
      return activeFile;
    }

    const activeLeafFile = this.app.workspace.activeLeaf
      ? getReadingFileFromLeaf(this.app.workspace.activeLeaf)
      : null;
    if (activeLeafFile) {
      this.lastReadingFilePath = activeLeafFile.path;
      return activeLeafFile;
    }

    const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
    const mostRecentFile = mostRecentLeaf ? getReadingFileFromLeaf(mostRecentLeaf) : null;
    if (mostRecentFile) {
      this.lastReadingFilePath = mostRecentFile.path;
      return mostRecentFile;
    }

    if (this.lastReadingFilePath) {
      const lastFile = this.app.vault.getAbstractFileByPath(this.lastReadingFilePath);
      if (lastFile instanceof TFile && getReadingSourceType(lastFile)) {
        return lastFile;
      }
    }

    const openReadingFiles: TFile[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = getReadingFileFromLeaf(leaf);
      if (file) openReadingFiles.push(file);
    });
    const openReadingFile = openReadingFiles[0];
    if (openReadingFile) {
      this.lastReadingFilePath = openReadingFile.path;
      return openReadingFile;
    }

    const markdownView = this.getReadingMarkdownView();
    if (markdownView?.file && getReadingSourceType(markdownView.file)) {
      this.lastReadingFilePath = markdownView.file.path;
      return markdownView.file;
    }
    return null;
  }

  private getReadingMarkdownView(filePath?: string): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && (!filePath || activeView.file?.path === filePath)) return activeView;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && (!filePath || leaf.view.file?.path === filePath)) {
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

  private registerSelectionListenersInFrames() {
    for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
      let frameDocument: Document | null = null;
      try {
        frameDocument = iframe.contentDocument;
      } catch {
        continue;
      }
      if (!frameDocument || this.selectionFrameDocuments.has(frameDocument)) continue;
      this.selectionFrameDocuments.add(frameDocument);
      this.registerDomEvent(frameDocument, "selectionchange", () => {
        this.captureSelectionSnapshot();
      });
      this.registerDomEvent(frameDocument, "mouseup", () => {
        window.setTimeout(() => this.captureSelectionSnapshot(), 0);
      });
      this.registerDomEvent(frameDocument, "keyup", () => {
        window.setTimeout(() => this.captureSelectionSnapshot(), 0);
      });
    }
  }

  private captureSelectionSnapshot() {
    const domSelection = getCurrentDomSelectionSnapshot();
    if (!domSelection?.text) return;

    const file = this.getActiveReadingFile();
    if (!file) return;

    const markdownView = getReadingSourceType(file) === "markdown" ? this.getReadingMarkdownView(file.path) : null;
    const editor = markdownView?.editor;
    const editorSelection = editor?.getSelection() ?? "";
    const hasEditorSelection = Boolean(editorSelection.trim());

    this.lastMarkedText = trimToLimit(domSelection.text, this.settings.maxContextChars);
    this.lastSelectionSnapshot = {
      filePath: file.path,
      text: this.lastMarkedText,
      from: hasEditorSelection && editor ? cloneEditorPosition(editor.getCursor("from")) : undefined,
      to: hasEditorSelection && editor ? cloneEditorPosition(editor.getCursor("to")) : undefined,
      locationLabel: domSelection.locationLabel,
      pageNumber: domSelection.pageNumber,
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
  ): Promise<MarkedSelectionResult | null> {
    const selectedText = context.selection?.text.trim();
    if (!selectedText) return null;

    const content = await this.app.vault.read(file);
    const range = findSelectionRangeInContent(content, selectedText, context.cursorLine);
    if (!range) return null;
    if (isContentRangeAlreadyHighlighted(content, range.start, range.end)) {
      const existingAnchorId = getHighlightAnchorAfterContentRange(content, range.end + 2);
      const anchorId = existingAnchorId ?? createHighlightAnchorId();
      if (!existingAnchorId) {
        const insertAt = Math.min(content.length, range.end + 2);
        const updated = `${content.slice(0, insertAt)}${formatHighlightAnchorMarkup(anchorId)}${content.slice(insertAt)}`;
        await this.app.vault.modify(file, updated);
      }
      return {
        filePath: file.path,
        text: content.slice(range.start, range.end),
        startLine: getLineNumberAtOffset(content, range.start),
        endLine: getLineNumberAtOffset(content, range.end),
        anchorId,
      };
    }

    const anchorId = createHighlightAnchorId();
    const original = content.slice(range.start, range.end);
    const updated = `${content.slice(0, range.start)}==${original}==${formatHighlightAnchorMarkup(anchorId)}${content.slice(range.end)}`;
    await this.app.vault.modify(file, updated);

    return {
      filePath: file.path,
      text: original,
      startLine: getLineNumberAtOffset(content, range.start),
      endLine: getLineNumberAtOffset(content, range.end),
      anchorId,
    };
  }

  async appendHighlightDiscussion(
    anchor: MarkedSelectionResult,
    context: ExtendedReadingContext,
    question: string,
    result: CodexRunResult,
    record: PersistedQuestionRecord,
    readingNotePath: string,
  ): Promise<string> {
    const noteFolder = normalizePath(this.settings.noteFolder || DEFAULT_SETTINGS.noteFolder);
    const highlightFolder = normalizePath(`${noteFolder}/高亮批注`);
    await this.ensureFolder(highlightFolder);

    const targetPath = normalizePath(`${highlightFolder}/${anchor.anchorId}.md`);
    const sourceLink = formatWikiLink(context.activeFilePath, context.activeFileName);
    const questionNodeLink = formatWikiLink(record.questionNodePath, "问题节点");
    const readingNoteLink = formatWikiLink(readingNotePath, "阅读笔记");
    const trailLinks = record.readingTrailPaths.length
      ? record.readingTrailPaths.map((path) => formatWikiLink(path)).join("、")
      : "无";
    const entry = [
      "",
      `## ${formatLocalDateTime(new Date())}`,
      "",
      `- 来源：${sourceLink}，${formatMarkedSelectionLocation(anchor, context)}`,
      `- 问题节点：${questionNodeLink}`,
      `- 阅读笔记：${readingNoteLink}`,
      `- 阅读线索：${trailLinks}`,
      "",
      "**高亮原文**",
      "",
      blockquoteMarkdown(anchor.text),
      "",
      "**问题**",
      "",
      question.trim(),
      "",
      `**${PLUGIN_DISPLAY_NAME} 回答**`,
      "",
      formatAnswerForReadingNote(result),
      "",
    ].join("\n");

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, `${current.trimEnd()}\n${entry}`);
    } else {
      const header = [
        `# 高亮批注 ${anchor.anchorId}`,
        "",
        `来源：${sourceLink}`,
        `位置：${formatMarkedSelectionLocation(anchor, context)}`,
        "",
        `这个文件由 ${PLUGIN_DISPLAY_NAME} 自动维护，用来保存同一处高亮上的连续问题和讨论。`,
        "",
      ].join("\n");
      await this.app.vault.create(targetPath, `${header}${entry}`);
    }

    return targetPath;
  }

  private async handleHighlightNoteClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    const marker = target?.closest<HTMLElement>(".web-highlight-note[data-web-anchor]");
    if (!marker) return;

    event.preventDefault();
    event.stopPropagation();
    const anchorId = marker.dataset.webAnchor;
    if (!anchorId) return;
    await this.showHighlightPopover(anchorId, marker);
  }

  private async showHighlightPopover(anchorId: string, marker: HTMLElement) {
    this.closeHighlightPopover();

    const noteFolder = normalizePath(this.settings.noteFolder || DEFAULT_SETTINGS.noteFolder);
    const notePath = normalizePath(`${noteFolder}/高亮批注/${anchorId}.md`);
    const popover = document.body.createDiv({ cls: "web-highlight-popover" });
    const markerRect = marker.getBoundingClientRect();
    const maxLeft = Math.max(16, window.innerWidth - 390);
    popover.style.left = `${Math.min(markerRect.right + 10, maxLeft)}px`;
    popover.style.top = `${Math.max(16, Math.min(markerRect.top - 12, window.innerHeight - 460))}px`;

    const header = popover.createDiv({ cls: "web-highlight-popover-header" });
    header.createDiv({ cls: "web-highlight-popover-title", text: `${PLUGIN_DISPLAY_NAME} 高亮批注` });
    const closeButton = header.createEl("button", {
      cls: "web-highlight-popover-close",
      text: "×",
      attr: { "aria-label": "关闭高亮批注" },
    });
    closeButton.addEventListener("click", () => this.closeHighlightPopover());

    const body = popover.createDiv({ cls: "web-highlight-popover-body" });
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) {
      const markdown = await this.app.vault.read(file);
      await MarkdownRenderer.render(this.app, markdown, body, notePath, this);
    } else {
      body.createDiv({
        cls: "web-highlight-popover-empty",
        text: `这里还没有保存讨论。发送一次 ${PLUGIN_DISPLAY_NAME} 问题后，这个高亮处会记录问题和回答。`,
      });
    }

    const footer = popover.createDiv({ cls: "web-highlight-popover-footer" });
    const openButton = footer.createEl("button", {
      cls: "web-highlight-popover-open",
      text: "打开批注笔记",
    });
    openButton.addEventListener("click", () => {
      void this.app.workspace.openLinkText(notePath, "", false);
      this.closeHighlightPopover();
    });

    this.highlightPopover = popover;
  }

  private closeHighlightPopover() {
    this.highlightPopover?.remove();
    this.highlightPopover = null;
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
    return PLUGIN_DISPLAY_NAME;
  }

  getIcon(): string {
    return PLUGIN_ICON_ID;
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
  const [running, setRunning] = useState(false);
  const [model, setModel] = useState(() => normalizeCodexModel(plugin.settings.defaultModel));
  const [reasoningPreset, setReasoningPreset] = useState<CodexReasoningPreset>(() =>
    normalizeReasoningPreset(plugin.settings.defaultReasoningPreset),
  );
  const [forceVaultRetrieval, setForceVaultRetrieval] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<StoredReadingConversation[]>(() =>
    plugin.getConversationHistory(),
  );
  const [sessionId, setSessionId] = useState(() => createReadingSessionId());
  const [lastQuestion, setLastQuestion] = useState("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const contextSummary = useMemo(() => {
    if (!context) return null;
      return {
        source: context.activeFilePath,
        heading: context.headingPath.map((heading) => heading.text).join(" / ") || "无",
        selection: context.selection?.text
          ? trimToLimit(context.selection.text.replace(/\s+/g, " "), 220)
          : "无选区",
        location: formatContextLocation(context),
        mode: `${reasoningPreset === "xhigh" ? "xH 深度" : "极速"}${forceVaultRetrieval ? " · 查库" : ""}`,
      };
  }, [context, forceVaultRetrieval, reasoningPreset]);

  const refreshContextQuietly = useCallback(async () => {
    try {
      const responseMode = buildResponseMode(reasoningPreset, forceVaultRetrieval);
      const nextContext = await plugin.buildReadingContext(undefined, "", {
        responseMode,
        forceVaultRetrieval,
      });
      setContext(nextContext);
    } catch (refreshError) {
      setContext(null);
    }
  }, [forceVaultRetrieval, plugin, reasoningPreset]);

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

  useEffect(() => {
    return () => abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const storedMessages = messages
      .filter((message): message is ChatMessage & { role: "user" | "assistant" | "system" } => {
        return (
          (message.role === "user" || message.role === "assistant" || message.role === "system") &&
          !message.isStreaming &&
          Boolean(message.content.trim())
        );
      })
      .map((message) => ({
        role: message.role,
        content: message.content,
      }))
      .slice(-MAX_STORED_MESSAGES);
    const firstQuestion = storedMessages.find((message) => message.role === "user")?.content;
    if (!firstQuestion) return;

    const timeout = window.setTimeout(() => {
      const now = Date.now();
      const existing = plugin
        .getConversationHistory()
        .find((conversation) => conversation.sessionId === sessionId);
      const conversation: StoredReadingConversation = {
        id: existing?.id ?? sessionId,
        sessionId,
        title: existing?.title ?? createConversationTitle(firstQuestion),
        sourcePath: context?.activeFilePath ?? existing?.sourcePath ?? "未知来源",
        sourceName: context?.activeFileName ?? existing?.sourceName,
        locationLabel: context ? formatContextLocation(context) : existing?.locationLabel,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        model,
        reasoningPreset,
        forceVaultRetrieval,
        messages: storedMessages,
      };
      void plugin.upsertConversationSnapshot(conversation).then(() => {
        setHistory(plugin.getConversationHistory());
      });
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [context, forceVaultRetrieval, messages, model, plugin, reasoningPreset, sessionId]);

  const askCodex = useCallback(async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? draft).trim();
    if (!question) {
      return;
    }

    setRunning(true);
    setDraft("");
    setLastQuestion(question);

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
    let markedSelection: MarkedSelectionResult | null = null;
    const responseMode = buildResponseMode(reasoningPreset, forceVaultRetrieval);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const nextContext = await plugin.buildReadingContext(undefined, question, {
        responseMode,
        forceVaultRetrieval,
      });
      setContext(nextContext);
      markedSelection = await plugin.markActiveSelection(nextContext);
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

      const result = await plugin.askCodex(
        nextContext,
        question,
        history,
        {
          model,
          reasoningPreset,
          responseMode,
          forceVaultRetrieval,
          abortSignal: abortController.signal,
        },
      );
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
        if (markedSelection) {
          await plugin.appendHighlightDiscussion(
            markedSelection,
            nextContext,
            question,
            result,
            persistedRecord,
            notePath,
          );
        }
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
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
      }
      setRunning(false);
    }
  }, [draft, forceVaultRetrieval, messages, model, plugin, reasoningPreset]);

  const stopCurrentAnswer = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const retryLastQuestion = useCallback(() => {
    if (!lastQuestion || running) return;
    void askCodex(lastQuestion);
  }, [askCodex, lastQuestion, running]);

  const startNewConversation = useCallback(() => {
    if (running) {
      new Notice("当前回答还在进行，先停止或等待完成。");
      return;
    }
    setMessages([]);
    setDraft("");
    setLastQuestion("");
    setSessionId(createReadingSessionId());
    setHistoryOpen(false);
    void refreshContextQuietly();
  }, [refreshContextQuietly, running]);

  const restoreConversation = useCallback((conversation: StoredReadingConversation) => {
    if (running) {
      new Notice("当前回答还在进行，先停止或等待完成。");
      return;
    }
    setSessionId(conversation.sessionId);
    setMessages(
      conversation.messages.map((message) => ({
        id: createMessageId(),
        role: message.role,
        content: message.content,
      })),
    );
    setModel(normalizeCodexModel(conversation.model));
    setReasoningPreset(normalizeReasoningPreset(conversation.reasoningPreset));
    setForceVaultRetrieval(conversation.forceVaultRetrieval);
    setLastQuestion(
      conversation.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
    );
    setHistoryOpen(false);
    void refreshContextQuietly();
  }, [refreshContextQuietly, running]);

  const deleteConversation = useCallback(async (conversationId: string) => {
    await plugin.deleteConversationSnapshot(conversationId);
    setHistory(plugin.getConversationHistory());
  }, [plugin]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
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
      <div className="codex-reading-header">
        <div className="codex-reading-topbar">
          <div className="codex-reading-title">{PLUGIN_DISPLAY_NAME}</div>
          <div className="codex-reading-tools" aria-label={`${PLUGIN_DISPLAY_NAME} 工具栏`}>
            <select
              aria-label="Codex 模型"
              className="codex-model-select"
              disabled={running}
              onChange={(event) => setModel(normalizeCodexModel(event.currentTarget.value))}
              title="Codex 模型"
              value={model}
            >
              {CODEX_MODEL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.replace("gpt-", "")}
                </option>
              ))}
            </select>
            <select
              aria-label="思考强度"
              className="codex-model-select codex-reasoning-select"
              disabled={running}
              onChange={(event) => setReasoningPreset(normalizeReasoningPreset(event.currentTarget.value))}
              title="思考强度"
              value={reasoningPreset}
            >
              <option value="fast">快</option>
              <option value="xhigh">xH</option>
            </select>
            <button
              className="codex-icon-button"
              onClick={() => setHistoryOpen((open) => !open)}
              title="历史"
              type="button"
            >
              历史
            </button>
            <button
              className="codex-icon-button"
              onClick={() => plugin.toggleImmersiveMode()}
              title="沉浸式阅读"
              type="button"
            >
              沉浸
            </button>
            <button
              className="codex-icon-button"
              onClick={startNewConversation}
              title="新对话"
              type="button"
            >
              新
            </button>
          </div>
        </div>
        {contextSummary ? (
          <div className="codex-reading-context-line">
            <span>{contextSummary.source}</span>
            <span>{contextSummary.location}</span>
            <span>{contextSummary.selection === "无选区" ? "未标注" : "已标注"}</span>
            <span>{contextSummary.mode}</span>
          </div>
        ) : (
          <div className="codex-reading-context-line">打开 Markdown、PDF 或 EPUB 后即可提问</div>
        )}
        {historyOpen ? (
          <div className="codex-history-panel">
            {history.length ? (
              history.map((conversation) => (
                <div
                  className={`codex-history-item${
                    conversation.sessionId === sessionId ? " codex-history-item-active" : ""
                  }`}
                  key={conversation.id}
                >
                  <button
                    className="codex-history-open"
                    onClick={() => restoreConversation(conversation)}
                    type="button"
                  >
                    <span className="codex-history-title">{conversation.title}</span>
                    <span className="codex-history-meta">
                      {formatHistoryTimestamp(conversation.updatedAt)}
                      {conversation.sourceName ? ` · ${conversation.sourceName}` : ""}
                    </span>
                    <span className="codex-history-snippet">
                      {trimToLimit(
                        conversation.messages.at(-1)?.content.replace(/\s+/g, " ") ?? "",
                        88,
                      )}
                    </span>
                  </button>
                  <button
                    aria-label="删除历史对话"
                    className="codex-history-delete"
                    onClick={() => void deleteConversation(conversation.id)}
                    type="button"
                  >
                    删除
                  </button>
                </div>
              ))
            ) : (
              <div className="codex-history-empty">还没有可恢复的对话。</div>
            )}
          </div>
        ) : null}
      </div>

      <div className="codex-chat-list">
        {messages.length === 0 ? (
          <div className="codex-chat-empty">
            <div className="codex-chat-empty-mark">{PLUGIN_DISPLAY_NAME}</div>
            <div className="codex-chat-empty-title">等待你的阅读问题</div>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            className={`codex-chat-message codex-chat-message-${message.role}`}
            key={message.id}
          >
            <div className="codex-chat-message-label">
              {message.role === "user" ? "你" : message.role === "assistant" ? PLUGIN_DISPLAY_NAME : "系统"}
            </div>
            <div className="codex-chat-message-content">
              {message.structuredResponse ? (
                <StructuredAnswer response={message.structuredResponse} />
              ) : (
                message.content || (message.isStreaming ? `${PLUGIN_DISPLAY_NAME} 正在阅读...` : "")
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

      <div className="codex-chat-composer">
        <div className="codex-composer-tools">
          <button
            className={`codex-tool-button${forceVaultRetrieval ? " codex-tool-button-active" : ""}`}
            disabled={running}
            onClick={() => setForceVaultRetrieval((value) => !value)}
            type="button"
          >
            查库
          </button>
          <button
            className="codex-tool-button"
            disabled={running || !lastQuestion}
            onClick={retryLastQuestion}
            type="button"
          >
            重试
          </button>
          <button
            className="codex-tool-button"
            disabled={!running}
            onClick={stopCurrentAnswer}
            type="button"
          >
            停止
          </button>
        </div>
        <textarea
          className="codex-chat-input"
          disabled={running}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onComposerKeyDown}
          placeholder="问这段文字、概念或线索..."
          value={draft}
        />
        <button
          aria-label={running ? `${PLUGIN_DISPLAY_NAME} 正在阅读` : `发送给 ${PLUGIN_DISPLAY_NAME}`}
          className="mod-cta codex-chat-send"
          disabled={running || !draft.trim()}
          onClick={() => void askCodex()}
          title={running ? `${PLUGIN_DISPLAY_NAME} 正在阅读` : "发送"}
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

class CodexReadingSettingTab extends PluginSettingTab {
  private readonly plugin: CodexReadingPlugin;

  constructor(app: App, plugin: CodexReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: `${PLUGIN_DISPLAY_NAME} 设置` });

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
      .setName("默认 Codex 模型")
      .setDesc("右侧阅读面板默认使用的模型；可在面板顶部临时切换。")
      .addDropdown((dropdown) => {
        for (const model of CODEX_MODEL_OPTIONS) {
          dropdown.addOption(model, model.replace("gpt-", ""));
        }
        dropdown
          .setValue(normalizeCodexModel(this.plugin.settings.defaultModel))
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = normalizeCodexModel(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("默认思考强度")
      .setDesc("极速使用 low reasoning；xH 使用 xhigh reasoning，并默认进入深度上下文模式。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("fast", "极速")
          .addOption("xhigh", "xH")
          .setValue(normalizeReasoningPreset(this.plugin.settings.defaultReasoningPreset))
          .onChange(async (value) => {
            this.plugin.settings.defaultReasoningPreset = normalizeReasoningPreset(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("阅读笔记目录")
      .setDesc(`${PLUGIN_DISPLAY_NAME} 回答会追加到这个目录下的 companion note。`)
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

function normalizeCodexModel(value: string | undefined): string {
  const model = value?.trim();
  if (!model) return DEFAULT_CODEX_MODEL;
  return model;
}

function normalizeReasoningPreset(value: unknown): CodexReasoningPreset {
  return value === "xhigh" ? "xhigh" : "fast";
}

function getModelReasoningEffort(preset: CodexReasoningPreset): CodexModelReasoningEffort {
  return preset === "xhigh" ? "xhigh" : "low";
}

function buildResponseMode(
  reasoningPreset: CodexReasoningPreset,
  forceVaultRetrieval: boolean,
): CodexResponseMode {
  return reasoningPreset === "xhigh" || forceVaultRetrieval ? "deep" : "fast";
}

function buildPromptContext(
  context: ExtendedReadingContext,
  responseMode: CodexResponseMode,
): Record<string, unknown> {
  if (responseMode === "deep") return context as unknown as Record<string, unknown>;
  return {
    ...context,
    outline: context.outline.slice(0, 12),
    backlinks: context.backlinks.slice(0, 8),
    recentFiles: context.recentFiles.slice(0, 8),
    relatedNotes: [],
    surroundingText: trimToLimit(context.surroundingText, 3600),
    fileExcerpt: trimToLimit(context.fileExcerpt, 5200),
    agentMemoryExcerpt: context.agentMemoryExcerpt
      ? trimToLimit(context.agentMemoryExcerpt, 1800)
      : undefined,
    selection: context.selection
      ? {
          ...context.selection,
          text: trimToLimit(context.selection.text, 2600),
        }
      : undefined,
  };
}

function normalizeStoredReadingConversations(value: unknown): StoredReadingConversation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): StoredReadingConversation | null => {
      const record = asRecord(item);
      if (!record) return null;
      const id = firstString(record, ["id"]);
      const sessionId = firstString(record, ["sessionId", "session_id"]) || id;
      const title = firstString(record, ["title"]);
      if (!id || !sessionId || !title) return null;
      const messages = normalizeStoredReadingMessages(record.messages);
      if (!messages.length) return null;
      const createdAt = Number(record.createdAt);
      const updatedAt = Number(record.updatedAt);
      return {
        id,
        sessionId,
        title,
        sourcePath: firstString(record, ["sourcePath", "source"]) || "未知来源",
        sourceName: firstString(record, ["sourceName"]),
        locationLabel: firstString(record, ["locationLabel"]),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        model: normalizeCodexModel(firstString(record, ["model"])),
        reasoningPreset: normalizeReasoningPreset(record.reasoningPreset),
        forceVaultRetrieval: record.forceVaultRetrieval === true,
        messages,
      };
    })
    .filter((item): item is StoredReadingConversation => item !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
}

function normalizeStoredReadingMessages(value: unknown): StoredReadingMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): StoredReadingMessage | null => {
      const record = asRecord(item);
      if (!record) return null;
      const role = record.role;
      if (role !== "user" && role !== "assistant" && role !== "system") return null;
      const content = firstString(record, ["content"]);
      if (!content.trim()) return null;
      return {
        role,
        content,
      };
    })
    .filter((item): item is StoredReadingMessage => item !== null)
    .slice(-MAX_STORED_MESSAGES);
}

function upsertStoredReadingConversation(
  conversations: StoredReadingConversation[],
  conversation: StoredReadingConversation,
): StoredReadingConversation[] {
  const existing = conversations.find((item) => item.sessionId === conversation.sessionId);
  const nextConversation = existing
    ? {
        ...conversation,
        id: existing.id,
        createdAt: existing.createdAt,
        title: existing.title || conversation.title,
      }
    : conversation;
  return [nextConversation, ...conversations.filter((item) => item.sessionId !== conversation.sessionId)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_STORED_CONVERSATIONS);
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

function getAvailableActions(
  settings: CodexReadingSettings,
  sourceType: ReadingSourceType,
): NoteAction["type"][] {
  const actions: NoteAction["type"][] = ["appendReadingNote", "openRelatedNote"];
  if (sourceType === "markdown") {
    actions.push("insertAnswerCallout");
  }
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
  options: AskCodexOptions = {},
): string {
  const responseMode = options.responseMode ?? "fast";
  const isFast = responseMode === "fast";
  const promptContext = buildPromptContext(context, responseMode);
  const historyText = history.length
    ? history
        .map((message) => `${message.role === "user" ? "用户" : PLUGIN_DISPLAY_NAME}：${message.content}`)
        .join("\n\n")
    : "无";

  return [
    `你是一个嵌入 Obsidian 的 ${PLUGIN_DISPLAY_NAME} 阅读 agent。${PLUGIN_DISPLAY_NAME} 的目标是把用户阅读中的问题、回答、旧笔记和跨书关联织成一张知识网。底层运行时是 Codex CLI harness。`,
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
    `回答模式：${isFast ? "极速" : "深度"}`,
    isFast
      ? "当前是极速模式：优先直接解释当前选区/当前位置，不主动做完整知识网络整理；relatedEchoes、conceptLinks、readingTrails 可以为空。"
      : "当前是深度模式：可以结合相关笔记、历史问题节点和阅读线索展开，但必须标明依据路径。",
    `模型：${normalizeCodexModel(options.model ?? DEFAULT_CODEX_MODEL)}`,
    `思考强度：${normalizeReasoningPreset(options.reasoningPreset ?? "fast")}`,
    `查库状态：${context.relatedNotes.length ? `已命中 ${context.relatedNotes.length} 条相关笔记` : "未使用或未命中相关笔记"}`,
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
    isFast ? "阅读上下文 JSON（极速裁剪）：" : "阅读上下文 JSON：",
    "```json",
    JSON.stringify(promptContext, null, 2),
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
    `sourceType: ${context.sourceType}`,
    `line: ${context.cursorLine}`,
    `location: ${JSON.stringify(formatContextLocation(context))}`,
    context.pageNumber ? `page: ${context.pageNumber}` : null,
    `concepts: ${JSON.stringify(concepts)}`,
    `trails: ${JSON.stringify(trails)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 阅读现场",
    "",
    `- 来源：${sourceLink}`,
    `- 位置：${formatContextLocation(context)}`,
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
    `- 来源：${formatWikiLink(context.activeFilePath, context.activeFileName)}，${formatContextLocation(context)}`,
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

function formatLineLocation(line: number): string {
  return `第 ${Math.max(1, line)} 行`;
}

function formatContextLocation(context: ReadingContext): string {
  if (context.locationLabel?.trim()) return context.locationLabel;
  return formatLineLocation(context.cursorLine);
}

function formatMarkedSelectionLocation(anchor: MarkedSelectionResult, context: ReadingContext): string {
  if (context.selection?.locationLabel) return context.selection.locationLabel;
  return `第 ${anchor.startLine}-${anchor.endLine} 行`;
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

function getReadingSourceType(file: TFile): ReadingSourceType | null {
  const extension = file.extension.toLowerCase();
  if (extension === "md") return "markdown";
  if (extension === "pdf") return "pdf";
  if (extension === "epub") return "epub";
  return null;
}

function getReadingFileFromLeaf(leaf: WorkspaceLeaf): TFile | null {
  const viewWithFile = leaf.view as { file?: unknown };
  const file = viewWithFile.file;
  if (file instanceof TFile && getReadingSourceType(file)) {
    return file;
  }
  return null;
}

async function extractPdfReadingDocument(
  file: TFile,
  data: ArrayBuffer,
  textExtractor?: TextExtractorApi,
): Promise<ExtractedReadingDocument> {
  try {
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(data.slice(0)),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;

    try {
      const inputs: ExtractedBlockInput[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const pageText = extractPdfPageText(textContent.items);
        if (!pageText.trim()) continue;

        inputs.push({
          heading: `第 ${pageNumber} 页`,
          text: pageText,
          locationLabel: `第 ${pageNumber} 页`,
          pageNumber,
          outlineLevel: 1,
        });
      }

      if (inputs.length > 0) {
        return buildExtractedReadingDocument("pdf", inputs, pdf.numPages);
      }
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    const fallbackText = await extractPdfTextWithCompanionPlugin(file, textExtractor);
    if (fallbackText.trim()) {
      return buildPlainExtractedReadingDocument(
        "pdf",
        fallbackText,
        "PDF 文本",
        "PDF 文本",
      );
    }
    throw new Error(`无法抽取 PDF 文本：${toErrorMessage(error)}`);
  }

  const fallbackText = await extractPdfTextWithCompanionPlugin(file, textExtractor);
  if (fallbackText.trim()) {
    return buildPlainExtractedReadingDocument("pdf", fallbackText, "PDF 文本", "PDF 文本");
  }

  return buildPlainExtractedReadingDocument(
    "pdf",
    "这个 PDF 没有抽取到可用文本。若它是扫描版，请先做 OCR，或在 PDF 里选中一段可复制文字后再提问。",
    "PDF 文本",
    "PDF 文本不可用",
  );
}

async function extractPdfTextWithCompanionPlugin(
  file: TFile,
  textExtractor?: TextExtractorApi,
): Promise<string> {
  if (!textExtractor?.canFileBeExtracted(file.path)) return "";
  try {
    return await textExtractor.extractText(file);
  } catch {
    return "";
  }
}

function extractPdfPageText(items: unknown[]): string {
  const lines: string[] = [];
  let currentLine: string[] = [];

  const pushLine = () => {
    const line = normalizePdfLine(currentLine);
    if (line) lines.push(line);
    currentLine = [];
  };

  for (const item of items) {
    const textItem = asPdfTextItem(item);
    if (!textItem) continue;
    const text = textItem.str?.replace(/\s+/g, " ").trim();
    if (text) currentLine.push(text);
    if (textItem.hasEOL) pushLine();
  }
  pushLine();

  return normalizeExtractedText(lines.join("\n"));
}

function asPdfTextItem(value: unknown): PdfTextItem | null {
  const record = asRecord(value);
  if (!record || typeof record.str !== "string") return null;
  return {
    str: record.str,
    hasEOL: record.hasEOL === true,
  };
}

function normalizePdfLine(parts: string[]): string {
  return parts
    .join(" ")
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1")
    .replace(/\s+([，。！？、；：）】》])/g, "$1")
    .replace(/([（【《])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractEpubReadingDocument(
  file: TFile,
  data: ArrayBuffer,
): Promise<ExtractedReadingDocument> {
  const { configure, ZipReader, BlobReader, TextWriter } = await import("@zip.js/zip.js");
  configure({ useWebWorkers: false });

  const reader = new ZipReader(new BlobReader(new Blob([data])));
  try {
    const entries = await reader.getEntries();
    const entryMap = new Map(entries.map((entry) => [normalizeArchivePath(entry.filename), entry]));
    const readTextEntry = async (entryPath: string): Promise<string | null> => {
      const entry = findZipEntry(entryMap, entryPath);
      if (!entry || entry.directory || !entry.getData) return null;
      return entry.getData(new TextWriter());
    };

    const containerXml = await readTextEntry("META-INF/container.xml");
    if (!containerXml) {
      throw new Error("EPUB 缺少 META-INF/container.xml");
    }

    const containerDoc = parseXmlDocument(containerXml);
    const rootfilePath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
    if (!rootfilePath) {
      throw new Error("EPUB 缺少 OPF rootfile");
    }

    const opfPath = normalizeArchivePath(rootfilePath);
    const opfText = await readTextEntry(opfPath);
    if (!opfText) {
      throw new Error(`EPUB 无法读取 OPF：${opfPath}`);
    }

    const opfDoc = parseXmlDocument(opfText);
    const opfDir = getArchiveDirectory(opfPath);
    const metadataTitle =
      opfDoc.querySelector("metadata > title, metadata > dc\\:title")?.textContent?.trim() ??
      file.basename;
    const manifest = parseEpubManifest(opfDoc, opfDir);
    const spineItems = Array.from(opfDoc.querySelectorAll("spine > itemref"))
      .map((item) => item.getAttribute("idref") ?? "")
      .filter(Boolean)
      .map((idref) => manifest.get(idref))
      .filter((item): item is EpubManifestItem => Boolean(item));

    const inputs: ExtractedBlockInput[] = [];
    for (const item of spineItems) {
      if (!isEpubContentDocument(item.href, item.mediaType)) continue;
      const html = await readTextEntry(item.path);
      if (!html) continue;

      const htmlDoc = new DOMParser().parseFromString(html, "text/html");
      const chapterTitle = getHtmlDocumentTitle(htmlDoc) || item.title || metadataTitle;
      const chapterText = extractHtmlDocumentText(htmlDoc);
      if (!chapterText.trim()) continue;

      inputs.push({
        heading: chapterTitle,
        text: chapterText,
        locationLabel: chapterTitle,
        chapterTitle,
        outlineLevel: 1,
      });
    }

    if (inputs.length === 0) {
      return buildPlainExtractedReadingDocument(
        "epub",
        "这个 EPUB 没有抽取到可用正文。可能是图片型 EPUB，或正文结构不符合常见 EPUB 规范。",
        metadataTitle,
        "EPUB 文本不可用",
      );
    }

    return buildExtractedReadingDocument("epub", inputs);
  } finally {
    await reader.close();
  }
}

interface EpubManifestItem {
  id: string;
  href: string;
  path: string;
  mediaType: string;
  title?: string;
}

function parseEpubManifest(doc: Document, opfDir: string): Map<string, EpubManifestItem> {
  const manifest = new Map<string, EpubManifestItem>();
  for (const item of Array.from(doc.querySelectorAll("manifest > item"))) {
    const id = item.getAttribute("id") ?? "";
    const href = item.getAttribute("href") ?? "";
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href,
      path: resolveArchivePath(opfDir, href),
      mediaType: item.getAttribute("media-type") ?? "",
      title: item.getAttribute("title") ?? undefined,
    });
  }
  return manifest;
}

function isEpubContentDocument(href: string, mediaType: string): boolean {
  const lowerHref = href.toLowerCase();
  return (
    mediaType.includes("xhtml") ||
    mediaType.includes("html") ||
    lowerHref.endsWith(".xhtml") ||
    lowerHref.endsWith(".html") ||
    lowerHref.endsWith(".htm")
  );
}

function parseXmlDocument(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function getHtmlDocumentTitle(doc: Document): string {
  const heading = doc.querySelector("h1, h2, h3")?.textContent?.trim();
  if (heading) return normalizeInlineText(heading);
  const title = doc.querySelector("title")?.textContent?.trim();
  return title ? normalizeInlineText(title) : "";
}

function extractHtmlDocumentText(doc: Document): string {
  doc.querySelectorAll("script, style, noscript").forEach((element) => element.remove());
  const blockSelector =
    "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th, dd, dt, figcaption";
  const blocks = Array.from(doc.body?.querySelectorAll(blockSelector) ?? []);

  if (blocks.length === 0) {
    return normalizeExtractedText(doc.body?.textContent ?? "");
  }

  const lines: string[] = [];
  for (const block of blocks) {
    const text = normalizeInlineText(block.textContent ?? "");
    if (!text) continue;
    const tagName = block.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      lines.push(`${"#".repeat(Math.min(level, 6))} ${text}`);
    } else if (tagName === "li") {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  }

  return normalizeExtractedText(lines.join("\n\n"));
}

interface ExtractedBlockInput {
  heading: string;
  text: string;
  locationLabel: string;
  outlineLevel: number;
  pageNumber?: number;
  chapterTitle?: string;
}

function buildPlainExtractedReadingDocument(
  sourceType: Exclude<ReadingSourceType, "markdown">,
  text: string,
  heading: string,
  locationLabel: string,
): ExtractedReadingDocument {
  return buildExtractedReadingDocument(sourceType, [
    {
      heading,
      text,
      locationLabel,
      outlineLevel: 1,
    },
  ]);
}

function buildExtractedReadingDocument(
  sourceType: Exclude<ReadingSourceType, "markdown">,
  inputs: ExtractedBlockInput[],
  totalPages?: number,
): ExtractedReadingDocument {
  const parts: string[] = [];
  const blocks: ExtractedTextBlock[] = [];
  const outline: HeadingItem[] = [];
  let lineCursor = 1;

  for (const input of inputs) {
    const normalizedText = normalizeExtractedText(input.text);
    if (!normalizedText) continue;
    if (parts.length > 0) lineCursor += 2;

    const blockText = [`## ${input.heading}`, normalizedText].filter(Boolean).join("\n");
    const lineStart = lineCursor;
    const lineCount = blockText.split(/\r?\n/).length;
    const lineEnd = lineStart + lineCount - 1;

    parts.push(blockText);
    blocks.push({
      text: blockText,
      lineStart,
      lineEnd,
      locationLabel: input.locationLabel,
      pageNumber: input.pageNumber,
      chapterTitle: input.chapterTitle ?? input.heading,
    });
    outline.push({
      level: input.outlineLevel,
      text: input.heading,
      line: lineStart,
    });
    lineCursor = lineEnd;
  }

  const text = parts.join("\n\n");
  return {
    sourceType,
    text,
    outline,
    blocks,
    totalPages,
  };
}

function locateSelectionInExtractedDocument(
  document: ExtractedReadingDocument,
  selectedText: string,
  preferredPageNumber?: number,
): (ExtractedTextBlock & { block: ExtractedTextBlock; startLine: number; endLine: number }) | null {
  const normalizedSelection = normalizeForSearch(selectedText);
  if (!normalizedSelection) return null;

  const preferredBlocks =
    preferredPageNumber !== undefined
      ? document.blocks.filter((block) => block.pageNumber === preferredPageNumber)
      : [];
  const searchBlocks = [...preferredBlocks, ...document.blocks.filter((block) => !preferredBlocks.includes(block))];

  for (const block of searchBlocks) {
    if (normalizeForSearch(block.text).includes(normalizedSelection)) {
      return {
        ...block,
        block,
        startLine: block.lineStart,
        endLine: block.lineEnd,
      };
    }
  }

  const range = findSelectionRangeInContent(document.text, selectedText, 1);
  if (!range) return null;
  const startLine = getLineNumberAtOffset(document.text, range.start);
  const endLine = getLineNumberAtOffset(document.text, range.end);
  const block = findExtractedBlockByLine(document, startLine) ?? getDefaultExtractedTextBlock(document);
  if (!block) return null;

  return {
    ...block,
    block,
    startLine,
    endLine,
  };
}

function findExtractedBlockByLine(
  document: ExtractedReadingDocument,
  line: number,
): ExtractedTextBlock | null {
  return (
    document.blocks.find((block) => line >= block.lineStart && line <= block.lineEnd) ??
    null
  );
}

function getDefaultExtractedTextBlock(document: ExtractedReadingDocument): ExtractedTextBlock | null {
  return document.blocks[0] ?? null;
}

function buildExtractedHeadingPath(block?: ExtractedTextBlock | null): HeadingItem[] {
  if (!block) return [];
  return [
    {
      level: 1,
      text: block.chapterTitle ?? block.locationLabel,
      line: block.lineStart,
    },
  ];
}

function buildExtractedSurroundingText(
  document: ExtractedReadingDocument,
  activeBlock: ExtractedTextBlock | null,
  maxChars: number,
): string {
  if (!activeBlock) return trimToLimit(document.text, maxChars);
  const index = document.blocks.indexOf(activeBlock);
  if (index < 0) return trimToLimit(activeBlock.text, maxChars);

  let start = index;
  let end = index;
  let parts = [activeBlock.text];

  while (parts.join("\n\n").length < maxChars && (start > 0 || end < document.blocks.length - 1)) {
    if (start > 0) {
      start -= 1;
      parts = [document.blocks[start].text, ...parts];
    }
    if (parts.join("\n\n").length >= maxChars) break;
    if (end < document.blocks.length - 1) {
      end += 1;
      parts = [...parts, document.blocks[end].text];
    }
  }

  return trimToLimit(parts.join("\n\n"), maxChars);
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeArchivePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\\/g, "/");
}

function getArchiveDirectory(path: string): string {
  const normalized = normalizeArchivePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function resolveArchivePath(baseDir: string, href: string): string {
  const cleanHref = href.split("#")[0].split("?")[0];
  const combined = normalizeArchivePath(baseDir ? `${baseDir}/${cleanHref}` : cleanHref);
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function findZipEntry<T extends { filename: string; directory?: boolean }>(
  entries: Map<string, T>,
  path: string,
): T | null {
  const normalized = normalizeArchivePath(path);
  const direct = entries.get(normalized);
  if (direct) return direct;

  try {
    const decoded = decodeURIComponent(normalized);
    return entries.get(decoded) ?? null;
  } catch {
    return null;
  }
}

function getTextExtractor(app: App): TextExtractorApi | undefined {
  const appRecord = app as unknown as {
    plugins?: {
      plugins?: Record<string, { api?: unknown }>;
    };
  };
  const api = appRecord.plugins?.plugins?.["text-extractor"]?.api;
  const record = asRecord(api);
  if (!record) return undefined;
  if (typeof record.extractText !== "function" || typeof record.canFileBeExtracted !== "function") {
    return undefined;
  }
  return record as unknown as TextExtractorApi;
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
  const body = answer.trim() || `${PLUGIN_DISPLAY_NAME} 没有返回内容。`;
  return [
    `> [!answer]- ${PLUGIN_DISPLAY_NAME} 回答`,
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
  return /^>\s*\[!question\][+-]?\s*(?:(?:Codex|Web|think\s+anytime)\s*提问)?/i.test(line.trim());
}

function isAnswerCalloutHeader(line: string): boolean {
  return /^>\s*\[!answer\][+-]?\s*(?:(?:Codex|Web|think\s+anytime)\s*回答)?/i.test(line.trim());
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

function createReadingSessionId(): string {
  return `ob-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createConversationTitle(question: string): string {
  return trimToLimit(question.replace(/\s+/g, " ").trim(), 42) || "新对话";
}

function formatHistoryTimestamp(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function createHighlightAnchorId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `web-hl-${stamp}-${suffix}`;
}

function formatHighlightAnchorMarkup(anchorId: string): string {
  return `<span class="web-highlight-note" data-web-anchor="${anchorId}" title="展开 ${PLUGIN_DISPLAY_NAME} 讨论">✎</span>`;
}

function getCurrentDomSelectionSnapshot(): DomSelectionSnapshot | null {
  const windows: Window[] = [window];
  for (const iframe of Array.from(document.querySelectorAll("iframe"))) {
    try {
      if (iframe.contentWindow) windows.push(iframe.contentWindow);
    } catch {
      // 跨域 iframe 不能读取选区，直接跳过。
    }
  }

  for (const targetWindow of windows) {
    let selection: Selection | null | undefined;
    try {
      selection = targetWindow.getSelection?.();
    } catch {
      // 跨域 iframe 不能读取选区，直接跳过。
      continue;
    }
    const selectedText = selection?.toString().trim() ?? "";
    if (selectedText.length <= 1) continue;

    const anchorElement = getSelectionAnchorElement(selection);
    if (anchorElement?.closest(".codex-reading-root")) continue;
    const pageElement = anchorElement?.closest<HTMLElement>("[data-page-number]");
    const pageNumber = parseOptionalPositiveInteger(pageElement?.dataset.pageNumber);
    return {
      text: selectedText,
      pageNumber,
      locationLabel: pageNumber ? `第 ${pageNumber} 页` : undefined,
    };
  }

  return null;
}

function getSelectionAnchorElement(selection: Selection | null): Element | null {
  const anchorNode = selection?.anchorNode;
  if (!anchorNode) return null;
  if (anchorNode instanceof Element) return anchorNode;
  return anchorNode.parentElement;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
): MarkedSelectionResult | null {
  const selectedText = editor.getRange(from, to);
  if (!selectedText.trim()) return null;
  if (isEditorRangeAlreadyHighlighted(editor, from, to)) {
    const afterHighlight = getSameLinePosition(editor, to, 2);
    const existingAnchorId = getHighlightAnchorAfterEditorPosition(editor, afterHighlight);
    const anchorId = existingAnchorId ?? createHighlightAnchorId();
    if (!existingAnchorId) {
      editor.replaceRange(formatHighlightAnchorMarkup(anchorId), afterHighlight);
    }
    return {
      filePath,
      text: selectedText,
      startLine: from.line + 1,
      endLine: to.line + 1,
      anchorId,
    };
  }

  const anchorId = createHighlightAnchorId();
  editor.replaceRange(`==${selectedText}==${formatHighlightAnchorMarkup(anchorId)}`, from, to);
  return {
    filePath,
    text: selectedText,
    startLine: from.line + 1,
    endLine: to.line + 1,
    anchorId,
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

function getSameLinePosition(editor: Editor, position: EditorPosition, offset: number): EditorPosition {
  const lineLength = editor.getLine(position.line)?.length ?? position.ch;
  return {
    line: position.line,
    ch: Math.max(0, Math.min(lineLength, position.ch + offset)),
  };
}

function getHighlightAnchorAfterEditorPosition(
  editor: Editor,
  position: EditorPosition,
): string | null {
  const lineLength = editor.getLine(position.line)?.length ?? position.ch;
  const restOfLine = editor.getRange(position, { line: position.line, ch: lineLength });
  return getHighlightAnchorFromLeadingText(restOfLine);
}

function isContentRangeAlreadyHighlighted(content: string, start: number, end: number): boolean {
  return content.slice(Math.max(0, start - 2), start) === "==" && content.slice(end, end + 2) === "==";
}

function getHighlightAnchorAfterContentRange(content: string, offset: number): string | null {
  return getHighlightAnchorFromLeadingText(content.slice(offset, offset + 260));
}

function getHighlightAnchorFromLeadingText(value: string): string | null {
  const match = /^\s*<span\s+class=["']web-highlight-note["']\s+data-web-anchor=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/i.exec(
    value,
  );
  return match?.[1] ?? null;
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
