import { describe, expect, it } from "vitest";
import { buildDelegationRequest, ChatDecisionSchema, resolveChatDecision, type ConversationContextSnapshot, type ExtractedRequirementDraft } from "../src/index.js";

function draftWith(descriptions: readonly string[], overrides: Partial<ExtractedRequirementDraft> = {}): ExtractedRequirementDraft {
  return {
    title: "Tính năng thanh toán",
    objective: "Thêm tính năng thanh toán",
    kind: "feature",
    sddLevel: "lightweight",
    priority: "normal",
    scopeDefined: true,
    isLargeTask: false,
    affectedPaths: ["packages/billing"],
    acceptanceCriteriaDescriptions: [...descriptions],
    isRequirementChange: false,
    ...overrides
  };
}

function criteriaOf(draft: ExtractedRequirementDraft) {
  const result = buildDelegationRequest({
    sessionId: "session-criteria",
    correlationId: "corr-criteria",
    messageId: "msg-criteria",
    draft,
    requestedAt: "2031-01-01T00:00:00.000Z"
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.acceptanceCriteria;
}

describe("B1: acceptance criteria infer verification method and category", () => {
  it("does not force every criterion to unit_test/functional", () => {
    const criteria = criteriaOf(draftWith([
      "Tích hợp endpoint thanh toán trả về mã 200",
      "Giao diện hiển thị thông báo lỗi đúng nội dung",
      "Tài liệu README mô tả cấu hình mới",
      "Kiểu dữ liệu Invoice phải khai báo đủ trường",
      "Kiểm thử unit cho parser khi chuỗi rỗng",
      "Token JWT hết hạn sau 15 phút",
      "Tốc độ phản hồi dưới 200 ms"
    ]));

    expect(criteria.map(c => c.verificationMethod)).toEqual([
      "integration_test",
      "e2e_test",
      "manual_review",
      "typecheck",
      "unit_test",
      "unit_test",
      "unit_test"
    ]);
    expect(criteria.map(c => c.category)).toEqual([
      "functional",
      "functional",
      "functional",
      "functional",
      "edge_case",
      "security",
      "performance"
    ]);
  });

  it("keeps spike investigations on manual review", () => {
    const [criterion] = criteriaOf(draftWith(["Khảo sát cơ chế phê duyệt"], { kind: "spike" }));
    expect(criterion?.verificationMethod).toBe("manual_review");
  });

  it("lets the draft state an explicit verification method for a criterion", () => {
    const [criterion] = criteriaOf(draftWith(["Kiểm thử unit cho parser"], { verificationMethods: ["lint"] }));
    expect(criterion?.verificationMethod).toBe("lint");
  });

  it("does not misclassify non-security token terms (e.g. token-bucket, fencing token) as security criteria", () => {
    const criteria = criteriaOf(draftWith([
      "Module rate-limiter triển khai thuật toán token-bucket trong bộ nhớ (in-memory) với khả năng cấu hình capacity và refillRate",
      "Giới hạn lưu lượng theo mô hình token bucket cho các tác vụ đồng thời",
      "Kiểm tra fencing token tăng đơn điệu trước khi gửi lệnh qua transport",
      "Từ chối truy cập khi bearer token không hợp lệ"
    ]));

    expect(criteria.map(c => c.category)).toEqual([
      "functional",
      "functional",
      "functional",
      "security"
    ]);
  });
});

describe("per-criterion verification methods", () => {
  const descriptions = ["Parser trả về lỗi khi chuỗi rỗng", "Báo cáo review mã nguồn", "Giữ nguyên hành vi cũ và typecheck vượt qua"];

  it("maps each acceptanceCriteria entry to its own declared method", () => {
    const criteria = criteriaOf(draftWith([], { acceptanceCriteria: [
      { description: descriptions[0]!, verificationMethod: "unit_test" },
      { description: descriptions[1]!, verificationMethod: "manual_review" },
      { description: descriptions[2]!, verificationMethod: "unit_test" }
    ] }));
    expect(criteria.map(c => [c.description, c.verificationMethod])).toEqual([
      [descriptions[0], "unit_test"], [descriptions[1], "manual_review"], [descriptions[2], "unit_test"]
    ]);
  });

  it("applies a single legacy method to every criterion instead of inferring typecheck", () => {
    const criteria = criteriaOf(draftWith(descriptions, { verificationMethods: ["unit_test"] }));
    expect(criteria.map(c => c.verificationMethod)).toEqual(["unit_test", "unit_test", "unit_test"]);
  });

  it("rejects a short legacy method list instead of defaulting the missing criterion to typecheck", () => {
    const result = buildDelegationRequest({ sessionId: "session-criteria", correlationId: "corr-criteria", messageId: "msg-criteria",
      draft: draftWith(descriptions, { verificationMethods: ["unit_test", "manual_review"] }), requestedAt: "2031-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/2 entries for 3 acceptance criteria/);
  });

  it("rejects mixing acceptanceCriteria with the legacy fields", () => {
    const result = buildDelegationRequest({ sessionId: "session-criteria", correlationId: "corr-criteria", messageId: "msg-criteria",
      draft: draftWith(["Khác"], { acceptanceCriteria: [{ description: descriptions[0]!, verificationMethod: "unit_test" }] }),
      requestedAt: "2031-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
  });

  it("conversation_decide accepts acceptanceCriteria without acceptanceCriteriaDescriptions and rejects short method lists", () => {
    const context = { session: { sessionId: "session-criteria" }, workflows: {}, pendingClarifications: {} } as unknown as ConversationContextSnapshot;
    const base = { title: "Parser", objective: "Sửa parser", kind: "bugfix", sddLevel: "lightweight", priority: "normal",
      scopeDefined: true, isLargeTask: false, affectedPaths: [], isRequirementChange: false };
    const perCriterion = ChatDecisionSchema.parse({ intent: "workflow_request", requirementDraft: { ...base,
      acceptanceCriteria: [{ description: descriptions[0], verificationMethod: "unit_test" }] } });
    expect(resolveChatDecision(perCriterion, context).ok).toBe(true);
    const shortList = ChatDecisionSchema.parse({ intent: "workflow_request", requirementDraft: { ...base,
      acceptanceCriteriaDescriptions: descriptions, verificationMethods: ["unit_test", "manual_review"] } });
    const rejected = resolveChatDecision(shortList, context);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toMatch(/verificationMethods has 2 entries/);
  });
});
