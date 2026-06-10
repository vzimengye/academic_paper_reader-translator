import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });

  const documents = await prisma.document.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50
  });

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

  const document = await prisma.document.create({
    data: {
      userId: user.id,
      fileName: body.fileName,
      title: body.title?.trim() || body.fileName,
      sourceLanguage: body.sourceLanguage,
      targetLanguage: body.targetLanguage,
      pageCount: body.pageCount ?? 0,
      paragraphCount: body.paragraphCount ?? 0,
      status: body.status ?? "completed"
    }
  });

  return NextResponse.json({ document });
}
