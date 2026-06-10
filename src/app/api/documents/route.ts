import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { randomBytes } from "crypto";
import { getSql } from "@/lib/db";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });

  const sql = getSql();
  const documents = await sql`
    SELECT "id", "fileName", "title", "sourceLanguage", "targetLanguage", "status", "pageCount", "paragraphCount", "createdAt", "updatedAt"
    FROM "APR_Document"
    WHERE "userId" = ${user.id}
    ORDER BY "createdAt" DESC
    LIMIT 50
  `;

  return NextResponse.json({ documents });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });

  const body = (await request.json()) as {
    fileName?: string;
    title?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    pageCount?: number;
    paragraphCount?: number;
    status?: string;
  };

  if (!body.fileName || !body.sourceLanguage || !body.targetLanguage) {
    return NextResponse.json({ error: "文档信息不完整。" }, { status: 400 });
  }

  const id = randomBytes(16).toString("hex");
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO "APR_Document" ("id", "userId", "fileName", "title", "sourceLanguage", "targetLanguage", "pageCount", "paragraphCount", "status")
    VALUES (${id}, ${user.id}, ${body.fileName}, ${body.title?.trim() || body.fileName}, ${body.sourceLanguage}, ${body.targetLanguage}, ${body.pageCount ?? 0}, ${body.paragraphCount ?? 0}, ${body.status ?? "completed"})
    RETURNING "id", "fileName", "title", "sourceLanguage", "targetLanguage", "status", "pageCount", "paragraphCount", "createdAt", "updatedAt"
  `) as Array<Record<string, unknown>>;
  const document = rows[0];

  return NextResponse.json({ document });
}
