export const validUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const validPin = (value: unknown): value is string =>
  typeof value === "string" && /^\d{6}$/.test(value);
export function normalizeEmployeeCode(value: unknown) {
  if (typeof value !== "string" || value.length > 40) return "";
  const code = value
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (!/^TG\d{1,12}$/.test(code)) return "";
  return `TG-${code.slice(2).padStart(4, "0")}`;
}
