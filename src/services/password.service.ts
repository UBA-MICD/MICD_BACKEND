import bcrypt from "bcryptjs";

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
