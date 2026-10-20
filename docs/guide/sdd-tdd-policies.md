# Chính sách SDD & TDD

Trước implementation, cần Specification đã được chấp nhận với criterion records
cụ thể. `Specification` dùng schemaVersion **2**, khác config/workflow schema
`"1"`. Không lấy số dòng diff để quyết định mức SDD.

| Mẫu | P15 classification / level | P16 kết quả mẫu |
| --- | --- | --- |
| feature | standard / full | required |
| bugfix cục bộ | standard / lightweight | required |
| refactor cục bộ | standard / lightweight | recommended |
| docs thuần túy | trivial / lightweight | not_applicable |

Đây là kết quả của assessment mẫu đã chạy qua engine, không phải bảng override.
P15 yêu cầu full cho feature; security/public API/data schema/architecture/migration,
nhiều module hoặc high risk chuyển thành complex/full và cần human approval.
Ngay cả tài liệu có path nhạy cảm cũng có thể bị nâng mức. Project có thể yêu cầu
approval bổ sung; không được dùng config minimum để hạ classification của P15.

Lightweight vẫn cần vấn đề, scope, affected paths, criteria và traceability; standard
còn cần functional requirements và proposed test strategy. Full cần architecture,
security, rollback, TestStrategy và TddDecision; complex có thêm design/constraints/
contracts/tradeoffs, migration strategy khi có thay đổi data. Xem
[P15 validator](../../packages/specification/src/schema.ts).

Các file [sdd/*.assessment.json](../../templates/node-typescript/sdd/) là đầu vào
`ChangeAssessmentSchema`. Các [specifications/*.spec.json](../../templates/node-typescript/specifications/)
là draft hợp lệ cho `SpecificationDocumentSchema`, chứa `metadata.sdd` và
`metadata.conditionalTdd`; không giả mạo approvedBy hay artifact URI. Run/session
IDs và timestamp trong mẫu chỉ để schema/policy validation; host phải rebind rồi
resolve lại strategy, không chỉ sửa ID của decision đã hash.

P16 đọc bảy nhóm đầu vào: loại task, acceptance criteria, tác động thay đổi,
hạ tầng test, khả năng test, risk và quy ước dự án. `environment.tdd.policy`
không thay cho assessment đó. Để tùy chỉnh, sửa assessment phù hợp thực tế, khai
báo command tồn tại, rồi chạy `TestStrategyResolver.resolve(spec)` và
`validateAgainstSpecification(strategy, spec)` trong host.

| Mode | Nghĩa vụ |
| --- | --- |
| required | Red lỗi đúng hành vi trước khi cho implementation; giữ test revision/names/commands khi Green; rerun thành công sau Refactor |
| recommended | Có thể thực hành TDD; vẫn bắt buộc receipt verification độc lập thành công |
| not_applicable | Vẫn phải có alternative verification đúng loại criterion: manual review/lint/typecheck/schema/smoke khi phù hợp |

Thiếu package/test infrastructure không phải Red. Mixed behavioral changes có thể
bắt buộc TDD dù task mang tên docs/config. Domain logic/bugfix không được resolver
cho `not_applicable`; không có boolean tự khai để bỏ kiểm tra.

Evidence thật được ghi qua `recordEvidence`, `assertReadyToImplement` và
`assertEvidenceComplete`. Host phải xác thực runner, revision, thời gian và nội
dung log, ingest ArtifactProposal qua ArtifactStore để lấy reference đáng tin.
Một JSON strategy hợp lệ hoặc lời agent nói "tests passed" chưa phải evidence.
Các draft mẫu chưa có Red/Green/Refactor receipt; không được dùng chúng để tự
cho phép ghi source. Xem [Verification Loop](verification-loop.md).
