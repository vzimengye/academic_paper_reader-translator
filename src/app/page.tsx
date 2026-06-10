"use client";

import { useMemo, useRef, useState } from "react";
import type { PaperPage, PaperParagraph, TranslationItem, TranslationPayload } from "@/lib/paper";
import { detectLanguage } from "@/lib/paper";

type Status = "idle" | "reading" | "translating" | "ready" | "error";

type RenderedPage = PaperPage & {
  canvasUrl: string;
};

const TRANSLATION_BATCH_SIZE = 14;

type TextPiece = {
  text: string;
  mark: boolean;
  term?: TranslationItem["terms"][number];
};

function sentencePieces(text: string, highlight?: string): TextPiece[] {
  if (!highlight) return [{ text, mark: false }];
  const index = text.toLowerCase().indexOf(highlight.toLowerCase());
  if (index < 0) return [{ text, mark: false }];
  return [
    { text: text.slice(0, index), mark: false },
    { text: text.slice(index, index + highlight.length), mark: true },
    { text: text.slice(index + highlight.length), mark: false }
  ].filter((piece) => piece.text);
}

function renderWithTerms(text: string, item?: TranslationItem) {
  const terms = (item?.terms ?? []).filter((term) => term.target || term.source);
  if (!terms.length) return sentencePieces(text, item?.translatedCoreSentence);

  const pieces = sentencePieces(text, item?.translatedCoreSentence).flatMap((piece) => {
    if (piece.mark) return [piece];
    return terms.reduce<TextPiece[]>(
      (acc, term) => {
        const needle = term.target || term.source;
        return acc.flatMap((part) => {
          if (part.term || !needle) return [part];
          const idx = part.text.toLowerCase().indexOf(needle.toLowerCase());
          if (idx < 0) return [part];
          return [
            { text: part.text.slice(0, idx), mark: false },
            { text: part.text.slice(idx, idx + needle.length), mark: false, term },
            { text: part.text.slice(idx + needle.length), mark: false }
          ].filter((next) => next.text);
        });
      },
      [piece]
    );
  });

  return pieces;
}

async function extractPdf(file: File): Promise<{ pages: RenderedPage[]; fullText: string }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const pages: RenderedPage[] = [];
  const allText: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.35 });
    const textViewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Cannot create canvas context.");
    }

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport }).promise;

    const content = await page.getTextContent();
    const rows = content.items
      .map((item, index) => {
        const textItem = item as { str: string; transform: number[]; width: number; height: number };
        const [, , , , x, y] = textItem.transform;
        const height = textItem.height || 10;
        return {
          index,
          text: textItem.str.trim(),
          x,
          y: textViewport.height - y,
          width: Math.max(textItem.width, 8),
          height: Math.max(height, 8)
        };
      })
      .filter((item) => item.text)
      .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));

    const paragraphs: PaperParagraph[] = [];
    let current: typeof rows = [];

    const flush = () => {
      if (!current.length) return;
      const text = current.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
      if (text.length < 16) {
        current = [];
        return;
      }
      const left = Math.min(...current.map((item) => item.x));
      const top = Math.min(...current.map((item) => item.y - item.height));
      const right = Math.max(...current.map((item) => item.x + item.width));
      const bottom = Math.max(...current.map((item) => item.y + item.height * 0.25));
      paragraphs.push({
        id: `p${pageNumber}-${paragraphs.length}`,
        pageIndex: pageNumber - 1,
        text,
        box: { x: left, y: top, width: right - left, height: bottom - top }
      });
      allText.push(text);
      current = [];
    };

    rows.forEach((row, index) => {
      const prev = rows[index - 1];
      const verticalGap = prev ? Math.abs(row.y - prev.y) : 0;
      const newParagraph = current.length > 0 && verticalGap > 18;
      if (newParagraph) flush();
      current.push(row);
    });
    flush();

    pages.push({
      pageIndex: pageNumber - 1,
      width: textViewport.width,
      height: textViewport.height,
      paragraphs,
      canvasUrl: canvas.toDataURL("image/png")
    });
  }

  return { pages, fullText: allText.join("\n\n") };
}

async function translateInBatches(
  sourceLanguage: "en" | "zh",
  paragraphs: Array<Pick<PaperParagraph, "id" | "text">>,
  onBatch: (payload: TranslationPayload, done: number, total: number) => void
) {
  let payload: TranslationPayload | null = null;

  for (let index = 0; index < paragraphs.length; index += TRANSLATION_BATCH_SIZE) {
    const batch = paragraphs.slice(index, index + TRANSLATION_BATCH_SIZE);
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceLanguage, paragraphs: batch })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `翻译请求失败：${response.status}`);
    }

    const next = (await response.json()) as TranslationPayload;
    if (payload) {
      payload.items = [...payload.items, ...next.items];
    } else {
      payload = { sourceLanguage: next.sourceLanguage, targetLanguage: next.targetLanguage, items: next.items };
    }

    onBatch(payload, Math.min(index + batch.length, paragraphs.length), paragraphs.length);
  }

  if (!payload) {
    throw new Error("没有可翻译的段落。");
  }

  return payload;
}

export default function Home() {
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [translation, setTranslation] = useState<TranslationPayload | null>(null);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("导入英文或中文 PDF，系统会快速识别内容并生成新的双语 HTML 文档。");
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const translationMap = useMemo(() => {
    return new Map((translation?.items ?? []).map((item) => [item.id, item]));
  }, [translation]);

  const paragraphs = useMemo(() => pages.flatMap((page) => page.paragraphs), [pages]);

  async function handleFile(file: File) {
    setStatus("reading");
    setFileName(file.name);
    setTranslation(null);
    setProgress(8);
    setMessage("正在解析 PDF 页面、段落和版面坐标...");

    try {
      const extracted = await extractPdf(file);
      setProgress(28);
      const sourceLanguage = detectLanguage(extracted.fullText);
      const extractedParagraphs = extracted.pages.flatMap((page) =>
        page.paragraphs.map((paragraph) => ({ id: paragraph.id, text: paragraph.text }))
      );
      setPages(extracted.pages);
      setStatus("translating");
      setProgress(32);
      setMessage(sourceLanguage === "zh" ? "检测到中文论文，正在生成英文版..." : "检测到英文论文，正在生成中文版...");
      setTranslation({ sourceLanguage, targetLanguage: sourceLanguage === "zh" ? "en" : "zh", items: [] });

      await translateInBatches(sourceLanguage, extractedParagraphs, (partial, done, total) => {
        setTranslation({ ...partial, items: [...partial.items] });
        setProgress(32 + Math.round((done / total) * 66));
        setMessage(`正在翻译段落 ${done} / ${total}...`);
      });

      setStatus("ready");
      setProgress(100);
      setMessage(sourceLanguage === "zh" ? "英文 HTML 文档已生成。" : "中文 HTML 文档已生成。");
    } catch (error) {
      setStatus("error");
      setProgress(0);
      const detail = error instanceof Error ? error.message : "处理 PDF 时发生错误。";
      setMessage(detail === "Failed to fetch" ? "网络请求失败，请刷新后重试；如果 PDF 很大，可以先用较短论文测试。" : detail);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Academic Paper Reader Translator</p>
          <h1>双语论文快速生成器</h1>
        </div>
        <div className="actions">
          <input
            ref={fileRef}
            className="hidden-input"
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <button type="button" onClick={() => fileRef.current?.click()}>
            导入 PDF
          </button>
          <button type="button" className="ghost" disabled={!translation} onClick={() => window.print()}>
            打印 / 导出
          </button>
        </div>
      </header>

      <section className="status-strip" data-state={status}>
        <span>{status === "idle" ? "待导入" : status === "ready" ? "已完成" : status === "error" ? "出错" : "处理中"}</span>
        <strong>{fileName || "还没有选择文件"}</strong>
        <p>{message}</p>
        <div className="progress-wrap" aria-hidden={status === "idle"}>
          <div className="progress-meta">
            <span>进度</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="progress-bar" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </section>

      {pages.length === 0 ? (
        <section className="empty-state" onClick={() => fileRef.current?.click()}>
          <div>
            <p>把 PDF 放进来，左边快速识别原文，右边生成新的 HTML 译文文档。</p>
            <span>译文按段落顺序实时出现；图表和图片直接使用原 PDF 页面截图。</span>
          </div>
        </section>
      ) : (
        <section className="reader-grid">
          <div className="column-heading">
            <span>原文档截图</span>
            <span>生成 HTML 文档</span>
          </div>
          <div className="document-layout">
            <div className="source-stack">
              {pages.map((page) => (
                <div className="paper-page source-page compact" key={page.pageIndex} style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                  <img src={page.canvasUrl} alt={`Original page ${page.pageIndex + 1}`} />
                </div>
              ))}
            </div>

            <article className="generated-document">
              <header className="document-title">
                <p>{translation ? `${translation.sourceLanguage.toUpperCase()} -> ${translation.targetLanguage.toUpperCase()}` : "生成中"}</p>
                <h2>{fileName.replace(/\.pdf$/i, "") || "Translated Paper"}</h2>
              </header>

              {pages.map((page) => (
                <section className="document-section" key={page.pageIndex}>
                  <h3>Page {page.pageIndex + 1}</h3>
                  <figure className="page-snapshot">
                    <img src={page.canvasUrl} alt={`Original visual snapshot for page ${page.pageIndex + 1}`} />
                    <figcaption>原页截图，用于保留图表、公式和图片参考。</figcaption>
                  </figure>

                  {page.paragraphs.map((paragraph) => {
                    const item = translationMap.get(paragraph.id);
                    return (
                      <p className={`document-paragraph${item ? "" : " pending"}`} key={paragraph.id}>
                        {renderWithTerms(item?.translatedText ?? "等待生成中...", item).map((piece, index) =>
                          piece.term ? (
                            <span className="term" data-tip={piece.term.explanation} key={`${paragraph.id}-${index}`}>
                              {piece.text}
                            </span>
                          ) : piece.mark ? (
                            <mark key={`${paragraph.id}-${index}`}>{piece.text}</mark>
                          ) : (
                            <span key={`${paragraph.id}-${index}`}>{piece.text}</span>
                          )
                        )}
                      </p>
                    );
                  })}
                </section>
              ))}
            </article>
          </div>
        </section>
      )}

      {paragraphs.length > 0 && (
        <footer className="summary">
          已识别 {pages.length} 页、{paragraphs.length} 个段落。
          {translation ? ` 翻译方向：${translation.sourceLanguage.toUpperCase()} -> ${translation.targetLanguage.toUpperCase()}。` : ""}
        </footer>
      )}
    </main>
  );
}
