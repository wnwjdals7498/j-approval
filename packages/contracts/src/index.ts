export const APPROVAL_PATHS = {
  documents: "/approval/documents",
  document: (id: string) => "/approval/documents/" + encodeURIComponent(id),
  history: (id: string) =>
    "/approval/documents/" + encodeURIComponent(id) + "/history",
  decisions: (id: string) =>
    "/approval/documents/" + encodeURIComponent(id) + "/decisions",
} as const;
export const APPROVAL_LIMITS = {
  title: 200,
  body: 20000,
  reason: 2000,
  stages: 32,
  page: 50,
} as const;
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalListView = "authored" | "pending" | "processed";
export interface SubmitDocument {
  readonly title: string;
  readonly body: string;
  readonly memberIds: readonly string[];
}
export interface DocumentSummary {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly status: ApprovalStatus;
  readonly currentStage: number | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ApprovalDocument extends DocumentSummary {
  readonly body: string;
  readonly memberIds: readonly string[];
}
export interface DocumentPage {
  readonly items: readonly DocumentSummary[];
  readonly nextCursor: string | null;
}
export type DecideDocument =
  | { readonly revision: number; readonly action: "approve" }
  | {
      readonly revision: number;
      readonly action: "reject";
      readonly reason: string;
    };
export interface ApprovalHistory {
  readonly id: string;
  readonly action: "submitted" | "viewed" | "approved" | "rejected";
  readonly actorId: string;
  readonly stage: number | null;
  readonly reason: string | null;
  readonly createdAt: string;
}
export interface HistoryPage {
  readonly items: readonly ApprovalHistory[];
  readonly nextCursor: string | null;
}
