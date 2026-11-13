import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { validPin } from "./attendance-input";
export { validPin, validUuid, normalizeEmployeeCode } from "./attendance-input";
function derive(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      pin,
      Buffer.from(salt, "hex"),
      64,
      { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export async function hashAttendancePin(pin: string) {
  if (!validPin(pin)) throw Error("Choose a six-digit PIN.");
  const salt = randomBytes(16).toString("hex"),
    hash = (await derive(pin, salt)).toString("hex");
  return { salt, hash };
}
export async function verifyAttendancePin(
  pin: string,
  salt: string,
  hash: string,
) {
  if (
    !validPin(pin) ||
    !/^[a-f0-9]{32}$/.test(salt) ||
    !/^[a-f0-9]{128}$/.test(hash)
  )
    return false;
  return timingSafeEqual(await derive(pin, salt), Buffer.from(hash, "hex"));
}
export const attendanceRateKey = (
  secret: string,
  kind: "ip" | "code",
  value: string,
) => createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
