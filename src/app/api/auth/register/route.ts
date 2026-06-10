import { NextResponse } from "next/server";
import { createSession, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const body = (await request.json()) as { email?: string; password?: string; name?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";
  const name = body.name?.trim() || null;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "请输入有效邮箱。" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "密码至少需要 8 位。" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "这个邮箱已经注册。" }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: { email, name, passwordHash: hashPassword(password) },
    select: { id: true, email: true, name: true, createdAt: true }
  });

  await createSession(user.id);
  return NextResponse.json({ user });
}
