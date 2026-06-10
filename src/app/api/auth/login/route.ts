import { NextResponse } from "next/server";
import { createSession, verifyPassword } from "@/lib/auth";
import { getSql } from "@/lib/db";

export async function POST(request: Request) {
  const body = (await request.json()) as { email?: string; password?: string };
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!email || !password) {
    return NextResponse.json({ error: "请输入邮箱和密码。" }, { status: 400 });
  }

  const sql = getSql();
  const rows = (await sql`SELECT "id", "email", "name", "passwordHash", "createdAt" FROM "APR_User" WHERE "email" = ${email} LIMIT 1`) as Array<{
    id: string;
    email: string;
    name: string | null;
    passwordHash: string;
    createdAt: string | Date;
  }>;
  const user = rows[0] as { id: string; email: string; name: string | null; passwordHash: string; createdAt: string | Date } | undefined;
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "邮箱或密码不正确。" }, { status: 401 });
  }

  await createSession(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt } });
}
