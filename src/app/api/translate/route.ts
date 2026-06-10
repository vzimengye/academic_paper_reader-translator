import { NextResponse } from "next/server";
import type { TranslateRequest, TranslationPayload } from "@/lib/paper";

export const runtime = "nodejs";

const BASE_URL = process.env.PPIO_BASE_URL ?? "https://api.ppio.com/openai";
const MODEL = process.env.PPIO_MODEL ?? "deepseek/deepseek-v3/community";

type ModelItem = {
  id: string;
  translatedText: string;
  coreSentence?: string;
  translatedCoreSentence?: string;
  terms?: Array<{ source: string; target?: string; explanation: string }>;
};

function cleanJson(raw: string) {
  const trimmed = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function fallbackTranslate(body: TranslateRequest): TranslationPayload {
  const targetLanguage = body.sourceLanguage === "zh" ? "en" : "zh";
  const fast = body.mode === "fast";
  return {
    sourceLanguage: body.sourceLanguage,
    targetLanguage,
    items: body.paragraphs.map((paragraph) => ({
      id: paragraph.id,
      translatedText:
        targetLanguage === "zh"
          ? `【演示译文】${paragraph.text}`
          : `[Demo translation] ${paragraph.text}`,
      coreSentence: fast ? "" : (paragraph.text.split(/[.!?。！？]/).find(Boolean)?.trim() ?? paragraph.text),
      translatedCoreSentence: fast ? "" : targetLanguage === "zh" ? "这是一句自动识别的核心句。" : "This is an auto-detected key sentence.",
      terms: []
    }))
  };
}

export async function POST(request: Request) {
  const body = (await request.json()) as TranslateRequest;
  const targetLanguage = body.sourceLanguage === "zh" ? "en" : "zh";
  const mode = body.mode ?? "enrich";

  if (!body.paragraphs?.length) {
    return NextResponse.json({ error: "No paragraphs supplied." }, { status: 400 });
  }

  if (!process.env.PPIO_API_KEY) {
    return NextResponse.json(fallbackTranslate(body));
  }

  const prompt = {
    sourceLanguage: body.sourceLanguage,
    targetLanguage,
    mode,
    requirements: [
      mode === "fast"
        ? "Translate academic paper paragraphs as quickly and faithfully as possible."
        : "Improve metadata for already translated academic paragraphs while keeping translation faithful.",
      "Do not attempt to preserve the original PDF layout; the client will render a clean HTML document.",
      "Keep citations, formulas, symbols, numbers, figure/table references, and bracketed references unchanged.",
      "Return one result for every input paragraph id.",
      mode === "fast"
        ? "For speed, translatedText is required; coreSentence, translatedCoreSentence, and terms can be empty."
        : "Pick one core sentence per paragraph. For short paragraphs, pick the full paragraph.",
      mode === "fast"
        ? "Do not spend time extracting terms in this mode."
        : "Extract only important professional terms, abbreviations, methods, datasets, metrics, and domain concepts.",
      mode === "fast"
        ? "Return compact JSON."
        : "Each term explanation must be 1-3 sentences, using as many sentences as needed to be clear and concise, written in the target language."
    ],
    paragraphs: body.paragraphs
  };

  const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PPIO_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            mode === "fast"
              ? "You are a very fast, accurate bilingual academic translator. Return strict JSON only with shape {items:[{id,translatedText,coreSentence,translatedCoreSentence,terms}]}."
              : "You are a careful bilingual academic annotator. Return strict JSON only with shape {items:[{id,translatedText,coreSentence,translatedCoreSentence,terms:[{source,target,explanation}]}]}. Term explanations must be 1-3 clear sentences."
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return NextResponse.json({ error: "PPIO request failed.", detail }, { status: 502 });
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;

  if (typeof raw !== "string") {
    return NextResponse.json({ error: "Unexpected model response." }, { status: 502 });
  }

  const parsed = JSON.parse(cleanJson(raw)) as { items?: ModelItem[] };
  const byId = new Map((parsed.items ?? []).map((item) => [item.id, item]));

  return NextResponse.json({
    sourceLanguage: body.sourceLanguage,
    targetLanguage,
    items: body.paragraphs.map((paragraph) => {
      const item = byId.get(paragraph.id);
      return {
        id: paragraph.id,
        translatedText: item?.translatedText ?? paragraph.text,
        coreSentence: item?.coreSentence ?? paragraph.text,
        translatedCoreSentence: item?.translatedCoreSentence ?? item?.translatedText ?? paragraph.text,
        terms: item?.terms ?? []
      };
    })
  } satisfies TranslationPayload);
}
