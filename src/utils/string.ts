import type { Cookie } from "har-format";
import { camelCase, uniq } from "lodash-es";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const dateRegex =
  /(((20[012]\d|19\d\d)|(1\d|2[0123]))-((0[0-9])|(1[012]))-((0[1-9])|([12][0-9])|(3[01])))|(((0[1-9])|([12][0-9])|(3[01]))-((0[0-9])|(1[012]))-((20[012]\d|19\d\d)|(1\d|2[0123])))|(((20[012]\d|19\d\d)|(1\d|2[0123]))\/((0[0-9])|(1[012]))\/((0[1-9])|([12][0-9])|(3[01])))|(((0[0-9])|(1[012]))\/((0[1-9])|([12][0-9])|(3[01]))\/((20[012]\d|19\d\d)|(1\d|2[0123])))|(((0[1-9])|([12][0-9])|(3[01]))\/((0[0-9])|(1[012]))\/((20[012]\d|19\d\d)|(1\d|2[0123])))|(((0[1-9])|([12][0-9])|(3[01]))\.((0[0-9])|(1[012]))\.((20[012]\d|19\d\d)|(1\d|2[0123])))|(((20[012]\d|19\d\d)|(1\d|2[0123]))\.((0[0-9])|(1[012]))\.((0[1-9])|([12][0-9])|(3[01])))/;

export const getTypenameFromPath = (path: string) => {
  const parts = path.split(/[/|${|-}]/g);
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
  return camelCase(uniq(partsToKeep).join(" "));
};

export const getCookieSecurityName = (cookie: Cookie) => {
  const onlyAlphaNumeric = cookie.name.replace(/_/g, " ").replace(/[^a-zA-Z0-9 ]/g, "");
  return camelCase(`cookie ${onlyAlphaNumeric}`);
};
