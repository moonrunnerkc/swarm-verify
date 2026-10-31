import { z } from "zod";
import { predicateSchema } from "../verify/predicate.ts";
import { evidenceFilesSchema, integritySchema } from "./outcome.ts";
import { commitSchema, sha256Schema } from "./request.ts";

export const resultVersion = "swarm-verify.result/v1";

/**
 * What a verification returns: the signed predicate, plus what cannot sit inside the thing it
 * describes (the signature's own integrity and where the files were written) and the checks'
 * failure output for whoever repairs the candidate.
 */
export const verifyResultSchema = predicateSchema.extend({
  version: z.literal(resultVersion),
  snapshot: z.strictObject({
    base: commitSchema,
    patchSha256: sha256Schema,
    treeSha256: sha256Schema,
  }),
  integrity: integritySchema,
  evidence: evidenceFilesSchema,
  /** What the failing checks printed, verbatim and capped. Not part of the signed statement. */
  failureOutput: z.string(),
});
export type VerifyResult = z.infer<typeof verifyResultSchema>;
