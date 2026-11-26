import { z } from "zod";

/**
 * The conventions this measures in JavaScript and TypeScript sources, each with the values a
 * project can hold it to. Every one is counted from the syntax tree; none is a matter of taste a
 * reader has to judge.
 */
export const conventionValues = {
  exports: ["named", "default"],
  "function-names": ["camelCase", "snake_case"],
  "variable-names": ["camelCase", "snake_case"],
  "type-names": ["PascalCase"],
  "file-names": ["kebab-case", "camelCase", "snake_case", "PascalCase"],
  "explicit-any": ["forbidden"],
  "exported-return-types": ["explicit"],
  "empty-catch": ["forbidden"],
  "thrown-values": ["error-objects"],
  "exported-docs": ["documented"],
  "test-location": ["beside-sources", "tests-directory"],
} as const;

export type ConventionRule = keyof typeof conventionValues;

export const conventionRules: readonly ConventionRule[] = [
  "exports",
  "function-names",
  "variable-names",
  "type-names",
  "file-names",
  "explicit-any",
  "exported-return-types",
  "empty-catch",
  "thrown-values",
  "exported-docs",
  "test-location",
];

/** The value a project holds each rule to. A rule left out is not checked. */
export const conventionSetSchema = z.strictObject({
  exports: z.enum(conventionValues.exports).optional(),
  "function-names": z.enum(conventionValues["function-names"]).optional(),
  "variable-names": z.enum(conventionValues["variable-names"]).optional(),
  "type-names": z.enum(conventionValues["type-names"]).optional(),
  "file-names": z.enum(conventionValues["file-names"]).optional(),
  "explicit-any": z.enum(conventionValues["explicit-any"]).optional(),
  "exported-return-types": z.enum(conventionValues["exported-return-types"]).optional(),
  "empty-catch": z.enum(conventionValues["empty-catch"]).optional(),
  "thrown-values": z.enum(conventionValues["thrown-values"]).optional(),
  "exported-docs": z.enum(conventionValues["exported-docs"]).optional(),
  "test-location": z.enum(conventionValues["test-location"]).optional(),
});
export type ConventionSet = z.output<typeof conventionSetSchema>;

const sentences: Readonly<Record<string, string>> = {
  "exports=named": "Exports are named, never default.",
  "exports=default": "Each module's main export is its default export.",
  "explicit-any=forbidden": "No value is typed `any`.",
  "exported-return-types=explicit": "Exported functions declare their return type.",
  "empty-catch=forbidden": "A catch block is never empty.",
  "thrown-values=error-objects": "Only error objects are thrown, never literals.",
  "exported-docs=documented": "Every exported declaration has a doc comment.",
  "test-location=beside-sources": "Tests sit beside the sources they test.",
  "test-location=tests-directory": "Tests live in a tests directory.",
};

const named: Readonly<Record<string, string>> = {
  "function-names": "Functions",
  "variable-names": "Variables and parameters",
  "type-names": "Types, interfaces, classes and enums",
  "file-names": "Files",
};

/** The rule at a value as one plain sentence, for a proposal, a prompt or a report. */
export function conventionText(rule: ConventionRule, value: string): string {
  return sentences[`${rule}=${value}`] ?? `${named[rule] ?? rule} are named in ${value}.`;
}
