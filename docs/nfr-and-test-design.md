# NFR có thể kiểm chứng và kiểm thử theo rủi ro

Các skill mới trên `main` bổ sung cách làm rõ yêu cầu phi chức năng (NFR) và chọn phép kiểm tra tương xứng rủi ro. Đây là instruction/reference được pin, không phải engine benchmark, bộ gate mới hoặc permission grant. Chỉ áp dụng những góc nhìn liên quan đến tiêu chí và bề mặt thay đổi.

## Từ mong muốn đến tiêu chí nghiệm thu

Với yêu cầu như “nhanh”, “ổn định” hoặc “an toàn”, Specifier dùng một brief trong prose của yêu cầu/đặc tả:

| Cần làm rõ | Ví dụ nội dung cần quyết định |
| --- | --- |
| Outcome và rủi ro | Ai được lợi; lỗi, độ trễ hoặc rò rỉ nào phải kiểm soát? |
| Quan sát và oracle | Metric/đơn vị/comparator hoặc hành vi cho phép/từ chối; điều kiện pass/fail |
| Nguồn ngưỡng | Ai chấp nhận mục tiêu, vì sao phù hợp; `proposed` khi chưa được duyệt, `unknown` khi còn thiếu |
| Điều kiện | Workload/mix thao tác, lượng dữ liệu, concurrency, environment và dependency/config versions |
| Cách đo | Warm-up, measurement window, tập mẫu/aggregation, tool và command có thật được phép dùng |
| Evidence | Raw observations, fixture/environment identity, command/exit status, log đã che bí mật và candidate revision |

Không có mặc định SLA, percentile hoặc “điểm bảo mật” chung cho mọi task. Ví dụ p95 trong reference là đề xuất minh họa, không trở thành cam kết của dự án chỉ vì được copy. Với security, oracle có thể là một ma trận quyền truy cập và điều kiện không tiết lộ/không ghi dữ liệu.

Nếu ngưỡng, môi trường hay thẩm quyền còn thiếu, giữ draft/criterion pending, không đặt evidence ID giả. Câu hỏi cần quyết định được chuyển Runtime → Herdr → Conversation; phần công việc phụ thuộc chờ luồng spec hiện có, phần độc lập đã được cấp quyền có thể tiếp tục.

## Dùng contract và verification flow hiện có

`AcceptanceCriterion` đã có `description`, `category` (`non_functional`, `security`, `performance` khi phù hợp), `verificationMethod`, `required`, `status` và `evidenceArtifactIds`. Oracle/điều kiện đo nằm trong description và prose hỗ trợ của Specification; không thêm field JSON tùy ý như `threshold` hoặc method mới như `performance_test`.

Phân biệt bốn mốc:

1. **Đã mô tả:** có oracle và điều kiện.
2. **Sẵn sàng đo:** tool, fixture, runner và môi trường được cấp phép đã có.
3. **Đã thực hiện:** phép đo chạy trên revision xác định và giữ raw observations.
4. **Đã xác nhận:** verification độc lập đối chiếu kết quả với tiêu chí đã chấp nhận.

Schema parse được chỉ chứng minh tính hợp lệ dữ liệu. Thiếu runner là prerequisite gap; thiếu kết quả là evidence gap; hai trường hợp đều không được đổi thành pass. Performance/security/recovery criterion không tự chứng minh các thuộc tính ngoài môi trường đã đo, ví dụ local process crash không chứng nhận power-loss durability.

## Chọn kiểm tra theo rủi ro

Test plan cần nối rõ **criterion → rủi ro/góc nhìn → exact check/test identity → observation → evidence**. Chọn các góc nhìn cần thiết, ghi `N/A — lý do` cho phần không liên quan. Không áp toàn bộ checklist lên thay đổi tài liệu nhỏ và không chỉ đếm số test xanh.

| Góc nhìn | Khi cần chú ý |
| --- | --- |
| Nhóm đầu vào và giá trị biên | Validation, phép tính, kích thước, giới hạn, đầu vào thiếu/sai |
| Trạng thái và tổ hợp quyết định | Lifecycle, approval, retry, cancellation, các rule kết hợp |
| Concurrency và thứ tự | Lease/fence, duplicate delivery, thao tác cùng lúc và race ở ranh giới bất đồng bộ |
| Lỗi giữa chừng và recovery | Abort, timeout, crash, partial state và checkpoint/event replay |
| Tương thích trước/sau | Brownfield refactor, migration, adapter replacement; so cả payload/error/side effect |
| Entrypoint và wiring thật | CLI binary, HTTP/IPC, Runtime composition, subprocess nạp `dist/` |
| UI và quyền truy cập | DOM/layout/focus, phân quyền, tenant/resource boundary và dữ liệu được bảo vệ |

Tên test và method phải khớp `TestStrategy.criterionMappings`/check plan hiện có. Unit test với fake không thay integration qua entrypoint, browser runtime hoặc live provider evidence khi criterion yêu cầu những mức đó. Khi browser/live proof là bắt buộc nhưng thiếu grant, origin, lease/fence hoặc runner, ghi blocked/inconclusive và escalation theo luồng hiện có.

Runtime quản lý giao dịch lease trình duyệt độc quyền theo từng attempt (`BrowserResourceTransactions`), nhưng việc thêm reference browser không tự cấp quyền hay chứng nhận live Chrome/provider SDLC acceptance; khi thiếu grant, origin, lease/fence hoặc trình duyệt sẵn sàng thì công việc phải báo degraded/blocked theo đúng policy. Kiểm chứng UI/API qua app thật dùng gate owner `appChecks` ([verification runners](verification-runners.md#kiểm-tra-ứng-dụng-thật-appchecks)). Không tự cài load generator, scanner, browser hoặc backend chỉ vì skill gợi ý một phương pháp. Conditional TDD, independent gates, approvals và iteration bounds vẫn giữ nguyên.

### Race condition: test phải phân biệt được có lock hay không

Với tiêu chí về race condition, concurrency, lock, mutual exclusion, atomicity hoặc ordering, test chỉ là bằng chứng hợp lệ khi có đồng thời hai điều kiện:

1. **Điểm xen kẽ thật trong critical section:** một `await`, hook/clock/barrier được inject, deferred promise hoặc fake có thể dừng giữa bước đọc và bước ghi, để hai thao tác thực sự chồng lên nhau.
2. **Đối chứng âm (negative control):** khi bỏ bảo vệ hoặc thay bằng pass-through (ví dụ lock → no-op), đúng test đó phải fail. Ghi kết quả mutation, hoặc lập kế hoạch mutation check với kết quả fail mong đợi.

`Promise.all` trên các thao tác đồng bộ hoặc chỉ assert invariant cuối cùng không đủ. Anti-pattern: 25 lần `bucket.tryAcquire(1)` trong `Promise.all`, rồi assert 5 lần thành công. Nếu `refill()` và giảm token nằm trong `runExclusive` đồng bộ, Node đơn luồng vẫn cho kết quả đúng khi `AsyncLock` bị bỏ. Test này chỉ là *invariant coverage*, không chứng minh lock cần thiết.

Ví dụ đã sửa (pseudo-code; `betweenCheckAndTake` là test seam, không phải API runtime có sẵn):

```js
// Giữ hai thao tác ở giữa bước kiểm tra token và bước giảm token.
const gate = deferred();
const bucket = createTokenBucket({ capacity: 5, betweenCheckAndTake: () => gate.promise });

const pending = Array.from({ length: 25 }, () => bucket.tryAcquire(1));
gate.resolve();
const results = await Promise.all(pending);

assert.equal(results.filter(Boolean).length, 5);
```

Với lock đúng, chỉ 5 lần acquire thành công. Khi thay lock bằng pass-through, cả 25 lần cùng đọc được token trước khi giảm, nên cùng test phải fail (25 thay vì 5). Nếu implementation chưa có điểm inject, tester không tự sửa runtime code; báo prerequisite gap hoặc đề xuất seam qua Runtime → Herdr → Conversation. Nếu không được phép chạy mutation trong bản sao cách ly, không chấp nhận tiêu chí là đã chứng minh race safety.

## Reference đã được phân phối

| Consumer | Reference canonical |
| --- | --- |
| Specifier | [Brief NFR](../skills/sdlc/requirements-analysis/nfr-clarification.md) · [Bốn criterion mẫu](../skills/sdlc/specification-driven-development/nfr-examples.md) |
| Tester/QA | [Risk viewpoints và check mapping](../skills/verification/test-planning/references/risk-viewpoints.md) |
| Reviewer | [Risk review trên code/test](../skills/verification/review-code/references/test-risk-review.md) |
| Security reviewer | [Security test viewpoints](../skills/verification/security-review/references/security-test-viewpoints.md) |
| Browser inspection | [UI risk viewpoints](../skills/browser/browser-inspection/references/ui-risk-viewpoints.md) |

Bundle metadata/digest của catalog hiện tại là nguồn chuẩn, không chép digest từ một handoff cũ đã kết hợp với thay đổi khác. Nội dung và referenced resources cùng nằm trong inventory được pin; setup/install cần phê duyệt exact pin mới, session đang chạy giữ immutable generation cũ. Nếu một version đã cài có byte/digest khác, dừng để owner cấp version/pin hợp lệ; không ghi đè hoặc xóa store để ép hội tụ.

Các test mới kiểm tra schema của criterion mẫu, bundle/reference distribution, content integrity và compatibility của pin cũ. Chúng không phải kết quả đo NFR, chứng nhận provider tuân thủ instruction, hoặc full SDLC/browser acceptance. [Handoff NFR](../packages/skills/NFR_GUIDANCE_HANDOFF.md) giữ kết quả và giới hạn lịch sử; [runner matrix](verification-runners.md) và [known limitations](known-limitations-v3.md) ghi capability thực tế.
