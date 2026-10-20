import { describe, expect, it } from "vitest";
import { buildDelegationRequest, type ExtractedRequirementDraft } from "../src/index.js";

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
});
