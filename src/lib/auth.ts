import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getSql } from "@/lib/db";

export const SESSION_COOKIE = "apr_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  const id = randomBytes(16).toString("hex");
  const sql = getSql();
  await sql`INSERT INTO "Session" ("id", "token", "userId", "expiresAt") VALUES (${id}, ${token}, ${userId}, ${expiresAt.toISOString()})`;

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const sql = getSql();
    await sql`DELETE FROM "Session" WHERE "token" = ${token}`;
  }
  cookieStore.delete(SESSION_COOKIE);
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sql = getSql();
  const rows = (await sql`
    SELECT s."expiresAt", u."id", u."email", u."name", u."createdAt"
    FROM "Session" s
    JOIN "User" u ON u."id" = s."userId"
    WHERE s."token" = ${token}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const session = rows[0] as
    | { expiresAt: string | Date; id: string; email: string; name: string | null; createdAt: string | Date }
    | undefined;

  if (!session || new Date(session.expiresAt) < new Date()) {
    if (session) await sql`DELETE FROM "Session" WHERE "token" = ${token}`;
    return null;
  }

  return { id: session.id, email: session.email, name: session.name, createdAt: session.createdAt };
}
