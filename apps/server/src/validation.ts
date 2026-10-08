import type { SubmitDocument, DecideDocument } from "@j-approval/contracts";
import { APPROVAL_LIMITS } from "@j-approval/contracts";
import { ApiError } from "./errors.js";
const invalid = () =>
  new ApiError(400, "invalid_input", "Invalid approval input.");
export function submission(
  author: string,
  input: SubmitDocument,
): SubmitDocument {
  if (
    !input.title.trim() ||
    input.title.length > APPROVAL_LIMITS.title ||
    !input.body.trim() ||
    input.body.length > APPROVAL_LIMITS.body ||
    input.memberIds.length < 1 ||
    input.memberIds.length > APPROVAL_LIMITS.stages ||
    new Set(input.memberIds).size !== input.memberIds.length ||
    input.memberIds.includes(author) ||
    input.memberIds.some(
      (id) => !id.trim() || id.length > 128 || /[\x00-\x1f\x7f-\x9f]/.test(id),
    )
  )
    throw invalid();
  return {
    title: input.title.trim(),
    body: input.body,
    memberIds: [...input.memberIds],
  };
}
export function decision(input: DecideDocument): DecideDocument {
  if (
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    input.revision > 2147483647
  )
    throw invalid();
  if (input.action === "reject") {
    if (!input.reason.trim() || input.reason.length > APPROVAL_LIMITS.reason)
      throw invalid();
    return {
      revision: input.revision,
      action: input.action,
      reason: input.reason.trim(),
    };
  }
  if (input.action !== "approve") throw invalid();
  return input;
}
