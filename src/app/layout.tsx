import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Academic Paper Reader Translator",
  description: "Translate academic PDFs while preserving a side-by-side study layout."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
