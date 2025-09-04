export function sortObject(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(sortObject);
  } else if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort((left, right) => left.localeCompare(right))
      .reduce((result, key) => {
        result[key] = sortObject(obj[key]);
        return result;
      }, {} as any);
  }
  return obj;
}
