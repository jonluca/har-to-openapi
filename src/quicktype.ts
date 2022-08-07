import type { TargetLanguage } from "quicktype-core/dist/TargetLanguage";
import { InputData, jsonInputForTargetLanguage, quicktype } from "quicktype-core";
import { cloneDeep } from "lodash-es";
import RefParser from "@apidevtools/json-schema-ref-parser";

/**
 * This is a hotfix and really only a partial solution as it does not cover all cases.
 *
 * But it's the best we can do until we find or build a better library to handle references.
 *
 * original source https://github.com/asyncapi/modelina/pull/829/files
 */
const handleRootReference = (input: Record<string, any>): Record<string, any> => {
  //Because of https://github.com/APIDevTools/json-schema-ref-parser/issues/201 the tool cannot handle root references.
  //This really is a bad patch to fix an underlying problem, but until a full library is available, this is best we can do.
  const hasRootRef = input.$ref !== undefined;
  if (hasRootRef) {
    //When we encounter it, manually try to resolve the reference in the definitions section
    const hasDefinitionSection = input.definitions !== undefined;
    if (hasDefinitionSection) {
      const definitionLink = "#/definitions/";
      const referenceLink = input.$ref.slice(0, definitionLink.length);
      const referenceIsLocal = referenceLink === definitionLink;
      if (referenceIsLocal) {
        const definitionName = input.$ref.slice(definitionLink.length);
        const definition = input.definitions[String(definitionName)];
        const definitionExist = definition !== undefined;
        if (definitionExist) {
          delete input.$ref;
          return { ...definition, ...input };
        }
      }
    }
  }
  return input;
};

export const quicktypeJSON = async (
  targetLanguage: string | TargetLanguage,
  typeName: string,
  sampleArray: string | string[],
) => {
  const jsonInput = jsonInputForTargetLanguage(targetLanguage);

  await jsonInput.addSource({
    name: typeName,
    samples: [sampleArray].flat(),
  });

  const inputData = new InputData();
  inputData.addInput(jsonInput);

  const result = await quicktype({
    inputData,
    lang: targetLanguage,
    alphabetizeProperties: true,
    allPropertiesOptional: true,
    fixedTopLevels: true,
    ignoreJsonRefs: false,
    combineClasses: false,
  });

  const returnJSON = JSON.parse(result.lines.join("\n"));
  const parser = new RefParser();
  const derefd = handleRootReference(cloneDeep(returnJSON));
  const dereferenced = await parser.dereference(derefd, { dereference: { circular: "ignore" } });
  // if we have circular references we're kinda screwed, i think
  delete dereferenced.definitions;
  return dereferenced;
};
