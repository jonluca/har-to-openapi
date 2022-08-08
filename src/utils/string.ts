import type { Cookie } from "har-format";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const camelize = (str: string) =>
  str
    .replace(/(?:^\w|[A-Z]|\b\w)/g, function (word: string, index: number) {
      return index === 0 ? word.toLowerCase() : word.toUpperCase();
    })
    .replace(/\s+/g, "");

const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export const getTypenameFromPath = (path: string) => {
  const parts = path.split("/");
  const partsToKeep = [];
  for (const part of parts) {
    // if its blank, skip
    if (!part.length) {
      continue;
    }
    // if its a UUID, skip it
    if (uuidRegex.test(part)) {
      continue;
    }
    if (dateRegex.test(part)) {
      partsToKeep.push("date");
      continue;
    }
    // if its a number and greater than 3 digits, probably safe to skip?
    if (part.length >= 3 && !isNaN(Number(part))) {
      continue;
    }
    partsToKeep.push(part);
  }
  // kind of heuristics, but we want to filter out things that are like uuids or just numbers
  return camelize(partsToKeep.join(" "));
};

export const getCookieSecurityName = (cookie: Cookie) => {
  const onlyAlphaNumeric = cookie.name.replace(/_/g, " ").replace(/[^a-zA-Z0-9 ]/g, "");
  return camelize(`cookie ${onlyAlphaNumeric}`);
};
