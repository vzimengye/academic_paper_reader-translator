# Academic Paper Reader Translator

A Next.js + TypeScript web app for translating academic PDF papers into a mirrored bilingual reading layout.

## Features

- Upload an English or Chinese academic PDF.
- Automatically detect source language.
- Translate English papers to Chinese, and Chinese papers to English.
- Keep the original document on the left and the generated translated document on the right.
- Preserve page proportions and paragraph positions for a mirrored academic-paper layout.
- Highlight the core sentence of each paragraph with a note-style marker.
- Underline professional terms and show concise explanations on hover.
- Print or export the generated translation from the browser print dialog.

## Stack

- Next.js App Router
- TypeScript
- React
- PDF.js
- PPIO OpenAI-compatible API
- Vercel-ready serverless API route

## Environment

Create `.env.local` locally or configure the same values in Vercel:

```bash
PPIO_API_KEY=sk-your-ppio-key
PPIO_BASE_URL=https://api.ppio.com/openai
PPIO_MODEL=deepseek/deepseek-v3/community
```

Do not commit real API keys. `.env*` is ignored by git except `.env.example`.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. If that port is busy:

```bash
npm run dev -- --port 3100
```

## Production

```bash
npm run typecheck
npm run build
```

## Vercel

Set these environment variables in the Vercel project before deploying:

- `PPIO_API_KEY`
- `PPIO_BASE_URL`
- `PPIO_MODEL`

Then deploy the repository with Vercel's GitHub integration or the Vercel CLI.
