"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PaperPage, PaperParagraph, TranslationItem, TranslationPayload } from "@/lib/paper";
import { detectLanguage } from "@/lib/paper";

type Status = "idle" | "reading" | "translating" | "ready" | "error";

type RenderedPage = PaperPage & {
  canvasUrl: string;
};

const FAST_CONCURRENCY = 2;
const ENRICH_CONCURRENCY = 1;
const FAST_MAX_ITEMS = 22;
const ENRICH_MAX_ITEMS = 10;
const FAST_MAX_CHARS = 5600;
const ENRICH_MAX_CHARS = 3200;

type TextPiece = {
  text: string;
  mark: boolean;
  term?: TranslationItem["terms"][number];
};

type TranslationMode = "fast" | "enrich";

type TranslationUnit = {
  id: string;
  ids: string[];
  pageIndex: number;
  text: string;
};

type EditableTextProps = {
  as?: "p" | "h1" | "h2" | "h3" | "figcaption";
  className?: string;
  id?: string;
  text: string;
  item?: TranslationItem;
  editable: boolean;
  highlight?: boolean;
  onCommit: (text: string) => void;
};

type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
};

type DocumentRecord = {
  id: string;
  fileName: string;
  title?: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  pageCount: number;
  paragraphCount: number;
  createdAt: string;
};

type TextRow = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  column: "left" | "right" | "full";
};

function targetLanguageOf(sourceLanguage: "en" | "zh") {
  return sourceLanguage === "zh" ? "en" : "zh";
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function detectVisualCaption(text: string): PaperParagraph["role"] {
  const normalized = text.trim();
  if (/^(fig(?:ure)?\.?|graph|chart)\s*[\wIVXLC]+(?:\s*[.:：|\-])?/i.test(normalized) || /^图\s*\d+(?:\s*[.:：|\-])?/.test(normalized)) {
    return "figureCaption";
  }
  if (/^table\s*[\wIVXLC]+(?:\s*[.:：|\-])?/i.test(normalized) || /^表\s*\d+(?:\s*[.:：|\-])?/.test(normalized)) {
    return "tableCaption";
  }
  return "text";
}

function detectTextRole(text: string, fontSize: number, medianSize: number, pageIndex: number, top: number, pageHeight: number): PaperParagraph["role"] {
  const trimmed = text.trim();
  const visual = detectVisualCaption(trimmed);
  if (visual !== "text") return visual;

  if (/^(abstract|introduction|background|related work|method|methods|methodology|approach|experiments?|results?|discussion|limitations?|conclusion|references|acknowledg(e)?ments?|appendix)\b/i.test(trimmed)) {
    return "heading1";
  }

  if (/^\d+(\.\d+)*\.?\s+[A-Z][\w\s,():\-]{2,}$/.test(trimmed) && trimmed.length < 110) {
    return fontSize >= medianSize * 1.05 ? "heading1" : "heading2";
  }

  if (fontSize >= medianSize * 1.28 && trimmed.length < 120) return "heading1";
  if (fontSize >= medianSize * 1.14 && trimmed.length < 120) return "heading2";
  return "text";
}

function cropCanvas(canvas: HTMLCanvasElement, box: { x: number; y: number; width: number; height: number }, scale: number) {
  const sx = Math.max(0, Math.floor(box.x * scale));
  const sy = Math.max(0, Math.floor(box.y * scale));
  const sw = Math.min(canvas.width - sx, Math.floor(box.width * scale));
  const sh = Math.min(canvas.height - sy, Math.floor(box.height * scale));

  if (sw < 80 || sh < 60) return undefined;

  const cropped = document.createElement("canvas");
  cropped.width = sw;
  cropped.height = sh;
  const croppedContext = cropped.getContext("2d");
  if (!croppedContext) return undefined;
  croppedContext.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped.toDataURL("image/png");
}

function buildRows(
  contentItems: unknown[],
  pageWidth: number,
  pageHeight: number
): TextRow[] {
  const raw = contentItems
    .map((item, index) => {
      const textItem = item as { str: string; transform: number[]; width: number; height: number; fontName?: string };
      const [, b, c, d, x, y] = textItem.transform;
      const fontSize = Math.max(Math.hypot(b, d), textItem.height || 0, 1);
      return {
        index,
        text: textItem.str.trim(),
        x,
        y: pageHeight - y,
        width: Math.max(textItem.width, 2),
        height: Math.max(textItem.height || fontSize, 2),
        fontSize,
        fontName: textItem.fontName ?? "",
        column: "full" as TextRow["column"]
      };
    })
    .filter((item) => item.text);

  const grouped: Array<typeof raw> = [];

  raw
    .sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    .forEach((item) => {
      const row = grouped.find((candidate) => Math.abs(median(candidate.map((part) => part.y)) - item.y) < Math.max(3, item.fontSize * 0.45));
      if (row) row.push(item);
      else grouped.push([item]);
    });

  const rows = grouped
    .map((parts) => {
      const sorted = parts.sort((a, b) => a.x - b.x);
      const left = Math.min(...sorted.map((part) => part.x));
      const top = Math.min(...sorted.map((part) => part.y - part.height));
      const right = Math.max(...sorted.map((part) => part.x + part.width));
      const bottom = Math.max(...sorted.map((part) => part.y + part.height * 0.25));
      const fontSize = median(sorted.map((part) => part.fontSize));
      return {
        text: sorted.map((part) => part.text).join(" ").replace(/\s+/g, " ").trim(),
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        fontSize,
        fontName: sorted.map((part) => part.fontName).find(Boolean) ?? "",
        column: "full" as TextRow["column"]
      };
    })
    .filter((row) => row.text.length > 0);

  const bodyRows = rows.filter((row) => row.y > pageHeight * 0.18 && row.width < pageWidth * 0.58);
  const leftCount = bodyRows.filter((row) => row.x + row.width / 2 < pageWidth / 2).length;
  const rightCount = bodyRows.filter((row) => row.x + row.width / 2 >= pageWidth / 2).length;
  const isTwoColumn = Math.min(leftCount, rightCount) >= 8;

  rows.forEach((row) => {
    const center = row.x + row.width / 2;
    if (!isTwoColumn || row.width > pageWidth * 0.58 || row.x < pageWidth * 0.12 && row.x + row.width > pageWidth * 0.88) {
      row.column = "full";
    } else {
      row.column = center < pageWidth / 2 ? "left" : "right";
    }
  });

  if (!isTwoColumn) {
    return rows.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  }

  const fullRows = rows.filter((row) => row.column === "full").sort((a, b) => a.y - b.y);
  const columnRows = rows
    .filter((row) => row.column !== "full")
    .sort((a, b) => {
      if (a.column !== b.column) return a.column === "left" ? -1 : 1;
      return Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x;
    });

  const earlyFull = fullRows.filter((row) => row.y < pageHeight * 0.28);
  const lateFull = fullRows.filter((row) => row.y >= pageHeight * 0.28);
  return [...earlyFull, ...columnRows, ...lateFull].sort((a, b) => {
    const aEarly = a.column === "full" && a.y < pageHeight * 0.28;
    const bEarly = b.column === "full" && b.y < pageHeight * 0.28;
    if (aEarly || bEarly) return a.y - b.y;
    if (a.column === "full" && b.column !== "full") return a.y < b.y ? -1 : 1;
    if (a.column !== "full" && b.column === "full") return a.y < b.y ? -1 : 1;
    if (a.column !== b.column) return a.column === "left" ? -1 : 1;
    return Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x;
  });
}

function rowsToParagraphs(rows: TextRow[], pageIndex: number, pageHeight: number) {
  const paragraphs: PaperParagraph[] = [];
  const bodySize = median(rows.filter((row) => row.text.length > 20).map((row) => row.fontSize)) || 10;
  let current: TextRow[] = [];
  let currentRole: PaperParagraph["role"] = "text";

  const flush = () => {
    if (!current.length) return;
    const text = current.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 2) {
      current = [];
      return;
    }
    const left = Math.min(...current.map((item) => item.x));
    const top = Math.min(...current.map((item) => item.y));
    const right = Math.max(...current.map((item) => item.x + item.width));
    const bottom = Math.max(...current.map((item) => item.y + item.height));
    const fontSize = median(current.map((item) => item.fontSize));
    const fontName = current.map((item) => item.fontName).join(" ");
    paragraphs.push({
      id: `p${pageIndex + 1}-${paragraphs.length}`,
      pageIndex,
      text,
      role: currentRole,
      fontSize,
      fontWeight: /bold|black|heavy|semibold/i.test(fontName) || currentRole !== "text" ? "bold" : "regular",
      box: { x: left, y: top, width: right - left, height: bottom - top }
    });
    current = [];
  };

  rows.forEach((row, index) => {
    const role = detectTextRole(row.text, row.fontSize, bodySize, pageIndex, row.y, pageHeight);
    const prev = rows[index - 1];
    const verticalGap = prev ? Math.abs(row.y - (prev.y + prev.height)) : 0;
    const changedColumn = prev && row.column !== prev.column;
    const roleIsBlock = role !== "text";
    const currentIsBlock = currentRole !== "text";
    const newParagraph =
      current.length > 0 &&
      (changedColumn ||
        roleIsBlock ||
        currentIsBlock ||
        verticalGap > Math.max(12, bodySize * 1.35) ||
        /[.!?。！？]$/.test(current[current.length - 1].text) && verticalGap > bodySize * 0.65);

    if (newParagraph) flush();
    currentRole = current.length ? currentRole : role;
    current.push(row);
  });

  flush();
  normalizeFrontMatter(paragraphs, pageIndex, pageHeight);
  return paragraphs;
}

function normalizeFrontMatter(paragraphs: PaperParagraph[], pageIndex: number, pageHeight: number) {
  if (pageIndex !== 0) return;

  const abstractIndex = paragraphs.findIndex((paragraph) => /^abstract\b/i.test(paragraph.text.trim()));
  const frontEnd = abstractIndex > 0 ? abstractIndex : paragraphs.findIndex((paragraph) => paragraph.box.y > pageHeight * 0.42);
  const candidates = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) => {
      if (frontEnd >= 0 && index >= frontEnd) return false;
      if (paragraph.role === "figureCaption" || paragraph.role === "tableCaption") return false;
      if (paragraph.box.y > pageHeight * 0.36) return false;
      return paragraph.text.trim().length > 8;
    });

  if (!candidates.length) return;

  const titleCandidate =
    candidates
      .filter(({ paragraph }) => paragraph.text.length < 220)
      .sort((a, b) => (b.paragraph.fontSize ?? 0) - (a.paragraph.fontSize ?? 0) || a.paragraph.box.y - b.paragraph.box.y)[0] ?? candidates[0];

  candidates.forEach(({ paragraph, index }) => {
    paragraph.role = index === titleCandidate.index ? "title" : "frontMatter";
    paragraph.fontWeight = index === titleCandidate.index ? "bold" : paragraph.fontWeight ?? "regular";
  });
}

function attachVisualSnapshots(paragraphs: PaperParagraph[], canvas: HTMLCanvasElement, pageWidth: number, pageHeight: number) {
  const renderScale = canvas.width / pageWidth;

  paragraphs.forEach((paragraph, index) => {
    const role = paragraph.role ?? detectVisualCaption(paragraph.text);
    paragraph.role = role;

    if (role !== "figureCaption" && role !== "tableCaption") return;

    const previous = paragraphs[index - 1];
    const next = paragraphs[index + 1];
    const captionCenter = paragraph.box.x + paragraph.box.width / 2;
    const isColumnCaption = paragraph.box.width < pageWidth * 0.48;
    const gutter = pageWidth * 0.025;
    const columnBox =
      isColumnCaption && captionCenter < pageWidth / 2
        ? { x: pageWidth * 0.05, width: pageWidth * 0.45 - gutter }
        : isColumnCaption
          ? { x: pageWidth * 0.5 + gutter, width: pageWidth * 0.45 - gutter }
          : { x: pageWidth * 0.06, width: pageWidth * 0.88 };
    const minY = pageHeight * 0.04;
    const maxY = pageHeight * 0.96;
    let y = minY;
    let height = 0;

    if (role === "tableCaption") {
      y = Math.min(maxY, paragraph.box.y + paragraph.box.height + 8);
      const nextTop = next && Math.abs(next.box.x - paragraph.box.x) < pageWidth * 0.22 ? next.box.y - 10 : Math.min(maxY, y + pageHeight * 0.28);
      height = Math.min(pageHeight * 0.36, Math.max(0, nextTop - y));
    } else {
      const previousBottom =
        previous && Math.abs(previous.box.x - paragraph.box.x) < pageWidth * 0.22 ? previous.box.y + previous.box.height + 10 : Math.max(minY, paragraph.box.y - pageHeight * 0.32);
      const captionTop = Math.max(minY, paragraph.box.y - 8);
      y = Math.max(minY, Math.min(previousBottom, captionTop - pageHeight * 0.12));
      height = Math.min(pageHeight * 0.42, Math.max(0, captionTop - y));
    }

    if (height < 60) return;

    paragraph.imageUrl = cropCanvas(
      canvas,
      {
        x: columnBox.x,
        y,
        width: columnBox.width,
        height
      },
      renderScale
    );
  });
}

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

function renderTermsOnly(text: string, item?: TranslationItem) {
  const terms = (item?.terms ?? []).filter((term) => term.target || term.source);
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
    [{ text, mark: false }]
  );
}

function EditableText({
  as = "p",
  className,
  id,
  text,
  item,
  editable,
  highlight = false,
  onCommit
}: EditableTextProps) {
  const Tag = as;
  const pieces = highlight ? renderWithTerms(text, item) : renderTermsOnly(text, item);

  if (editable) {
    return (
      <Tag
        className={`${className ?? ""} editable-text`}
        id={id}
        contentEditable
        suppressContentEditableWarning
        onBlur={(event) => onCommit(event.currentTarget.innerText.trim())}
      >
        {text}
      </Tag>
    );
  }

  return (
    <Tag className={className} id={id}>
      {pieces.map((piece, index) =>
        piece.term ? (
          <span className="term" data-tip={piece.term.explanation} key={`${id ?? "text"}-${index}`}>
            {piece.text}
          </span>
        ) : piece.mark ? (
          <mark key={`${id ?? "text"}-${index}`}>{piece.text}</mark>
        ) : (
          <span key={`${id ?? "text"}-${index}`}>{piece.text}</span>
        )
      )}
    </Tag>
  );
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
    const viewport = page.getViewport({ scale: 2.2 });
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
    const rows = buildRows(content.items, textViewport.width, textViewport.height);
    const paragraphs = rowsToParagraphs(rows, pageNumber - 1, textViewport.height);
    attachVisualSnapshots(paragraphs, canvas, textViewport.width, textViewport.height);
    allText.push(...paragraphs.map((paragraph) => paragraph.text));

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

function shouldMergeWithNext(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 72) return true;
  if (trimmed.length < 140 && !/[.!?。！？:：]$/.test(trimmed)) return true;
  return false;
}

function buildTranslationUnits(pages: RenderedPage[]): TranslationUnit[] {
  const units: TranslationUnit[] = [];

  pages.forEach((page) => {
    let current: TranslationUnit | null = null;

    const flush = () => {
      if (!current) return;
      units.push(current);
      current = null;
    };

    page.paragraphs.forEach((paragraph) => {
      if (paragraph.role && paragraph.role !== "text") {
        flush();
        units.push({
          id: paragraph.id,
          ids: [paragraph.id],
          pageIndex: paragraph.pageIndex,
          text: paragraph.text
        });
        return;
      }

      const canMerge = current !== null && current.text.length + paragraph.text.length < 520;

      if (current && canMerge && shouldMergeWithNext(current.text)) {
        current.ids.push(paragraph.id);
        current.id = current.ids.join("__");
        current.text = `${current.text}\n${paragraph.text}`;
        return;
      }

      flush();
      current = {
        id: paragraph.id,
        ids: [paragraph.id],
        pageIndex: paragraph.pageIndex,
        text: paragraph.text
      };
    });

    flush();
  });

  return units;
}

function makeBatches(units: TranslationUnit[], mode: TranslationMode) {
  const maxItems = mode === "fast" ? FAST_MAX_ITEMS : ENRICH_MAX_ITEMS;
  const maxChars = mode === "fast" ? FAST_MAX_CHARS : ENRICH_MAX_CHARS;
  const batches: TranslationUnit[][] = [];
  let current: TranslationUnit[] = [];
  let charCount = 0;

  const flush = () => {
    if (!current.length) return;
    batches.push(current);
    current = [];
    charCount = 0;
  };

  units.forEach((unit) => {
    const nextChars = charCount + unit.text.length;
    if (current.length && (current.length >= maxItems || nextChars > maxChars)) {
      flush();
    }
    current.push(unit);
    charCount += unit.text.length;
  });

  flush();
  return batches;
}

function expandUnitItems(units: TranslationUnit[], items: Map<string, TranslationItem>) {
  const expanded: TranslationItem[] = [];

  units.forEach((unit) => {
    const item = items.get(unit.id);
    if (!item) return;

    expanded.push({ ...item, id: unit.ids[0] });
    unit.ids.slice(1).forEach((id) => {
      expanded.push({
        ...item,
        id,
        translatedText: "",
        coreSentence: "",
        translatedCoreSentence: "",
        terms: []
      });
    });
  });

  return expanded;
}

function mergeTranslationItem(previous: TranslationItem | undefined, next: TranslationItem, preferPreviousText = false): TranslationItem {
  return {
    id: next.id,
    translatedText: preferPreviousText ? previous?.translatedText || next.translatedText || "" : next.translatedText || previous?.translatedText || "",
    coreSentence: next.coreSentence || previous?.coreSentence || "",
    translatedCoreSentence: next.translatedCoreSentence || previous?.translatedCoreSentence || next.translatedText || "",
    terms: next.terms?.length ? next.terms : previous?.terms ?? []
  };
}

async function requestTranslationBatch(
  sourceLanguage: "en" | "zh",
  batch: TranslationUnit[],
  mode: TranslationMode
) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceLanguage,
      mode,
      paragraphs: batch.map((unit) => ({ id: unit.id, text: unit.text }))
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `翻译请求失败：${response.status}`);
  }

  return (await response.json()) as TranslationPayload;
}

async function requestTranslationBatchWithRecovery(
  sourceLanguage: "en" | "zh",
  batch: TranslationUnit[],
  mode: TranslationMode
): Promise<TranslationPayload> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestTranslationBatch(sourceLanguage, batch, mode);
    } catch (error) {
      await wait(650 * (attempt + 1));
    }
  }

  if (batch.length > 1) {
    const midpoint = Math.ceil(batch.length / 2);
    const [left, right] = await Promise.all([
      requestTranslationBatchWithRecovery(sourceLanguage, batch.slice(0, midpoint), mode),
      requestTranslationBatchWithRecovery(sourceLanguage, batch.slice(midpoint), mode)
    ]);

    return {
      sourceLanguage,
      targetLanguage: targetLanguageOf(sourceLanguage),
      items: [...left.items, ...right.items]
    };
  }

  const unit = batch[0];
  if (mode === "enrich") {
    return {
      sourceLanguage,
      targetLanguage: targetLanguageOf(sourceLanguage),
      items: []
    };
  }

  return {
    sourceLanguage,
    targetLanguage: targetLanguageOf(sourceLanguage),
    items: [
      {
        id: unit.id,
        translatedText: targetLanguageOf(sourceLanguage) === "zh" ? "该段暂时翻译失败，请稍后重试。" : "This paragraph could not be translated yet. Please retry later.",
        coreSentence: "",
        translatedCoreSentence: "",
        terms: []
      }
    ]
  };
}

async function translateUnits(
  sourceLanguage: "en" | "zh",
  units: TranslationUnit[],
  mode: TranslationMode,
  cache: Map<string, TranslationItem>,
  onBatch: (items: Map<string, TranslationItem>, done: number, total: number) => void
) {
  const items = new Map<string, TranslationItem>();
  const pending: TranslationUnit[] = [];
  let done = 0;

  units.forEach((unit) => {
    const cached = cache.get(`${sourceLanguage}:${mode}:${unit.text}`);
    if (cached) {
      items.set(unit.id, cached);
      done += 1;
    } else {
      pending.push(unit);
    }
  });

  if (done) onBatch(items, done, units.length);

  const batches = makeBatches(pending, mode);
  let cursor = 0;
  const concurrency = Math.min(mode === "fast" ? FAST_CONCURRENCY : ENRICH_CONCURRENCY, batches.length || 1);

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor];
      cursor += 1;
      const payload = await requestTranslationBatchWithRecovery(sourceLanguage, batch, mode);
      const byId = new Map(payload.items.map((item) => [item.id, item]));

      batch.forEach((unit) => {
        const previous = items.get(unit.id);
        const raw = byId.get(unit.id);
        const merged = mergeTranslationItem(previous, {
          id: unit.id,
          translatedText: raw?.translatedText ?? "",
          coreSentence: raw?.coreSentence ?? "",
          translatedCoreSentence: raw?.translatedCoreSentence ?? "",
          terms: raw?.terms ?? []
        });
        items.set(unit.id, merged);
        cache.set(`${sourceLanguage}:${mode}:${unit.text}`, merged);
      });

      done += batch.length;
      onBatch(items, Math.min(done, units.length), units.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return items;
}

async function parseApiError(response: Response) {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || `请求失败：${response.status}`;
  } catch {
    return `请求失败：${response.status}`;
  }
}

export default function Home() {
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [translation, setTranslation] = useState<TranslationPayload | null>(null);
  const [fileName, setFileName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("导入英文或中文 PDF，系统会快速识别内容并生成新的双语 HTML 文档。");
  const [progress, setProgress] = useState(0);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authName, setAuthName] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const translationCacheRef = useRef(new Map<string, TranslationItem>());

  const translationMap = useMemo(() => {
    return new Map((translation?.items ?? []).map((item) => [item.id, item]));
  }, [translation]);

  const paragraphs = useMemo(() => pages.flatMap((page) => page.paragraphs), [pages]);
  const navigationItems = useMemo(() => {
    return paragraphs
      .filter((paragraph) => paragraph.role === "title" || paragraph.role === "heading1" || paragraph.role === "heading2")
      .map((paragraph) => ({
        id: paragraph.id,
        role: paragraph.role,
        text: translationMap.get(paragraph.id)?.translatedText || paragraph.text
      }));
  }, [paragraphs, translationMap]);

  async function refreshDocuments() {
    const response = await fetch("/api/documents");
    if (!response.ok) return;
    const data = (await response.json()) as { documents: DocumentRecord[] };
    setDocuments(data.documents);
  }

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/auth/me");
      if (!response.ok) return;
      const data = (await response.json()) as { user: AuthUser | null };
      setUser(data.user);
      if (data.user) await refreshDocuments();
    })();
  }, []);

  async function submitAuth() {
    setAuthMessage("");
    const response = await fetch(`/api/auth/${authMode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: authEmail, password: authPassword, name: authName })
    });

    if (!response.ok) {
      setAuthMessage(await parseApiError(response));
      return;
    }

    const data = (await response.json()) as { user: AuthUser };
    setUser(data.user);
    setAuthPassword("");
    setAuthMessage(authMode === "login" ? "已登录。" : "注册成功。");
    await refreshDocuments();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setDocuments([]);
  }

  async function saveDocumentRecord(payload: {
    fileName: string;
    title?: string;
    sourceLanguage: string;
    targetLanguage: string;
    pageCount: number;
    paragraphCount: number;
  }) {
    if (!user) return;
    const response = await fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) await refreshDocuments();
  }

  function updateTranslatedText(id: string, text: string) {
    if (!text) return;
    setTranslation((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) => (item.id === id ? { ...item, translatedText: text } : item))
      };
    });
  }

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
      const units = buildTranslationUnits(extracted.pages);
      const unitItems = new Map<string, TranslationItem>();
      const publish = () => {
        setTranslation({
          sourceLanguage,
          targetLanguage: sourceLanguage === "zh" ? "en" : "zh",
          items: expandUnitItems(units, unitItems)
        });
      };

      setPages(extracted.pages);
      setStatus("translating");
      setProgress(32);
      setMessage(sourceLanguage === "zh" ? "检测到中文论文，正在快速生成英文正文..." : "检测到英文论文，正在快速生成中文正文...");
      setTranslation({ sourceLanguage, targetLanguage: targetLanguageOf(sourceLanguage), items: [] });

      await translateUnits(sourceLanguage, units, "fast", translationCacheRef.current, (partial, done, total) => {
        partial.forEach((item, id) => {
          unitItems.set(id, mergeTranslationItem(unitItems.get(id), item));
        });
        publish();
        setProgress(32 + Math.round((done / total) * 48));
        setMessage(`正在快速翻译 ${done} / ${total} 组内容...`);
      });

      setMessage("正文已生成，正在补充核心句和专业名词解释...");
      setProgress(82);

      try {
        await translateUnits(sourceLanguage, units, "enrich", translationCacheRef.current, (partial, done, total) => {
          partial.forEach((item, id) => {
            unitItems.set(id, mergeTranslationItem(unitItems.get(id), item, true));
          });
          publish();
          setProgress(82 + Math.round((done / total) * 17));
          setMessage(`正在补充术语解释 ${done} / ${total} 组内容...`);
        });
      } catch {
        setMessage("正文已生成，部分核心句或专业名词解释暂时未补全。");
      }

      setStatus("ready");
      setProgress(100);
      setMessage(sourceLanguage === "zh" ? "英文 HTML 文档已生成。" : "中文 HTML 文档已生成。");
      await saveDocumentRecord({
        fileName: file.name,
        title: extracted.pages.flatMap((page) => page.paragraphs).find((paragraph) => paragraph.role === "title")?.text ?? file.name.replace(/\.pdf$/i, ""),
        sourceLanguage,
        targetLanguage: targetLanguageOf(sourceLanguage),
        pageCount: extracted.pages.length,
        paragraphCount: extracted.pages.flatMap((page) => page.paragraphs).length
      });
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
          <button type="button" className="ghost" disabled={!translation} onClick={() => setEditMode((enabled) => !enabled)}>
            {editMode ? "完成编辑" : "编辑译文"}
          </button>
        </div>
      </header>

      <section className="account-panel">
        {user ? (
          <>
            <div className="account-summary">
              <strong>{user.name || user.email}</strong>
              <span>{user.email}</span>
            </div>
            <button type="button" className="ghost" onClick={() => void logout()}>
              退出登录
            </button>
            <div className="document-history">
              <strong>我的文档</strong>
              {documents.length ? (
                documents.slice(0, 6).map((document) => (
                  <div className="history-item" key={document.id}>
                    <span>{document.title || document.fileName}</span>
                    <small>
                      {document.sourceLanguage.toUpperCase()} → {document.targetLanguage.toUpperCase()} · {document.pageCount} 页 ·{" "}
                      {new Date(document.createdAt).toLocaleDateString()}
                    </small>
                  </div>
                ))
              ) : (
                <small>完成一次翻译后会自动保存记录。</small>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="auth-tabs">
              <button type="button" className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")}>
                登录
              </button>
              <button type="button" className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")}>
                注册
              </button>
            </div>
            {authMode === "register" && (
              <input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="昵称，可选" />
            )}
            <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="邮箱" />
            <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="密码，至少 8 位" type="password" />
            <button type="button" onClick={() => void submitAuth()}>
              {authMode === "login" ? "登录" : "注册"}
            </button>
            <span className="auth-message">{authMessage || "登录后会保存每个用户自己的文档记录。"}</span>
          </>
        )}
      </section>

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
          <div className={`reader-workspace${navCollapsed ? " nav-collapsed" : ""}`}>
            <aside className="doc-nav" aria-label="文档导览">
              <button
                type="button"
                className="nav-toggle"
                aria-expanded={!navCollapsed}
                onClick={() => setNavCollapsed((collapsed) => !collapsed)}
                title={navCollapsed ? "展开导览" : "收起导览"}
              >
                <span>{navCollapsed ? "展开" : "收起"}</span>
              </button>
              <div className="nav-content" aria-hidden={navCollapsed}>
                <strong>导览</strong>
                {navigationItems.length ? (
                  navigationItems.map((item) => (
                    <a className={item.role === "heading2" ? "sub" : ""} href={`#translated-${item.id}`} key={item.id}>
                      {item.text}
                    </a>
                  ))
                ) : (
                  <span>正在识别标题...</span>
                )}
              </div>
            </aside>

            <div className="aligned-pages">
              {pages.map((page) => (
                <article className="aligned-spread" key={page.pageIndex}>
                <div className="original-panel">
                  <div className="panel-label">Original · Page {page.pageIndex + 1}</div>
                  <div className="paper-page source-page compact" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                    <img src={page.canvasUrl} alt={`Original page ${page.pageIndex + 1}`} />
                  </div>
                </div>

                <section className="generated-document">
                  {page.pageIndex === 0 && (
                    <header className="document-title">
                      <p>{translation ? `${translation.sourceLanguage.toUpperCase()} -> ${translation.targetLanguage.toUpperCase()}` : "生成中"}</p>
                      <h2>{fileName.replace(/\.pdf$/i, "") || "Translated Paper"}</h2>
                    </header>
                  )}
                  <div className="panel-label">Translation · Page {page.pageIndex + 1}</div>

                  {page.paragraphs.map((paragraph) => {
                    const item = translationMap.get(paragraph.id);
                    if (item?.translatedText === "") return null;
                    const isVisual = paragraph.role === "figureCaption" || paragraph.role === "tableCaption";
                    if (isVisual) {
                      return (
                        <figure className="visual-block" key={paragraph.id}>
                          {paragraph.imageUrl && <img src={paragraph.imageUrl} alt={paragraph.text} />}
                          <EditableText
                            as="figcaption"
                            text={item?.translatedText ?? "等待生成中..."}
                            item={item}
                            editable={editMode}
                            onCommit={(text) => updateTranslatedText(paragraph.id, text)}
                          />
                        </figure>
                      );
                    }
                    if (paragraph.role === "frontMatter") {
                      return (
                        <EditableText
                          className={`document-paragraph front-matter${item ? "" : " pending"}`}
                          key={paragraph.id}
                          text={item?.translatedText ?? "等待生成中..."}
                          item={item}
                          editable={editMode}
                          onCommit={(text) => updateTranslatedText(paragraph.id, text)}
                        />
                      );
                    }
                    if (paragraph.role === "title" || paragraph.role === "heading1" || paragraph.role === "heading2") {
                      const HeadingTag = paragraph.role === "title" ? "h1" : paragraph.role === "heading1" ? "h2" : "h3";
                      return (
                        <EditableText
                          as={HeadingTag}
                          className={`translated-heading ${paragraph.role}`}
                          id={`translated-${paragraph.id}`}
                          key={paragraph.id}
                          text={item?.translatedText ?? "等待生成中..."}
                          item={item}
                          editable={editMode}
                          onCommit={(text) => updateTranslatedText(paragraph.id, text)}
                        />
                      );
                    }
                    return (
                      <EditableText
                        className={`document-paragraph${item ? "" : " pending"}`}
                        key={paragraph.id}
                        text={item?.translatedText ?? "等待生成中..."}
                        item={item}
                        editable={editMode}
                        highlight={paragraph.role === "text" || !paragraph.role}
                        onCommit={(text) => updateTranslatedText(paragraph.id, text)}
                      />
                    );
                  })}
                </section>
                </article>
              ))}
            </div>
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
