import bcrypt from "bcryptjs";
import { bcryptRounds } from "../../config/env";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptRounds);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
