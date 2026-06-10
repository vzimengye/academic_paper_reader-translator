export type PaperLanguage = "en" | "zh";

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PaperParagraph = {
  id: string;
  pageIndex: number;
  text: string;
  box: Box;
  role?: "text" | "title" | "heading1" | "heading2" | "figureCaption" | "tableCaption";
  imageUrl?: string;
  fontSize?: number;
  fontWeight?: "regular" | "bold";
};

export type PaperPage = {
  pageIndex: number;
  width: number;
  height: number;
  paragraphs: PaperParagraph[];
};

export type PaperTerm = {
  source: string;
  target?: string;
  explanation: string;
};

export type TranslationItem = {
  id: string;
  translatedText: string;
  coreSentence: string;
  translatedCoreSentence: string;
  terms: PaperTerm[];
};

export type TranslationPayload = {
  sourceLanguage: PaperLanguage;
  targetLanguage: PaperLanguage;
  items: TranslationItem[];
};

export type TranslateRequest = {
  sourceLanguage: PaperLanguage;
  mode?: "fast" | "enrich";
  paragraphs: Pick<PaperParagraph, "id" | "text">[];
};

export function detectLanguage(text: string): PaperLanguage {
  const compact = text.replace(/\s/g, "");
  if (!compact) return "en";
  const cjk = (compact.match(/[\u3400-\u9fff]/g) ?? []).length;
  return cjk / compact.length > 0.18 ? "zh" : "en";
}
