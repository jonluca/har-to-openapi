export const pad = (m: number, width: number, z = "0") => {
  const n = m.toString();
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
};
export const capitalize = (s: unknown): string => {
  if (typeof s !== "string") {
    return "";
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
};
