import { NextResponse } from "next/server";
import { createSession, hashPassword } from "@/lib/auth";
import { randomBytes } from "crypto";
import { getSql } from "@/lib/db";

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

  const sql = getSql();
  const existing = (await sql`SELECT "id" FROM "User" WHERE "email" = ${email} LIMIT 1`) as Array<Record<string, unknown>>;
  if (existing.length) {
    return NextResponse.json({ error: "这个邮箱已经注册。" }, { status: 409 });
  }

  const id = randomBytes(16).toString("hex");
  const rows = (await sql`
    INSERT INTO "User" ("id", "email", "name", "passwordHash")
    VALUES (${id}, ${email}, ${name}, ${hashPassword(password)})
    RETURNING "id", "email", "name", "createdAt"
  `) as Array<{ id: string; email: string; name: string | null; createdAt: string | Date }>;
  const user = rows[0];

  await createSession(user.id);
  return NextResponse.json({ user });
}
