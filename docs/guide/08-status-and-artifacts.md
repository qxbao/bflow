# 8. Đọc trạng thái và artifact

> **Legacy P00–P10:** hướng dẫn API/demo của Runtime cũ. Các giới hạn tích hợp trong trang phản ánh giai đoạn đó; luồng hiện tại dùng [installation](installation.md), [getting started](getting-started.md) và [implementation status](../implementation-status.md).

> **Phạm vi legacy P00–P10.** Trang này giữ API/demo và đánh giá integration ở thời điểm trước P19.
> Dùng [hướng dẫn hiện tại](README.md) cho onboarding, lifecycle/config.yaml và P19.
> Không áp dụng các nhận định integration cũ hoặc thao tác Core trực tiếp để bypass policy P19.

## Công cụ có sẵn

Với state directory do demo tạo:

```bash
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR>                                   # liệt kê run
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR> --run-id <RUN_ID>                 # chi tiết
node examples/runtime-demo/inspect-run.mjs --state-dir <DIR> --run-id <RUN_ID> --show <ARTIFACT_ID>
```

Script này chỉ dùng API công khai (`openSqliteRunStore`, `openFilesystemArtifactStore`); có thể dùng nó làm mẫu cho công cụ của bạn. Chưa có lệnh CLI chính thức.

## Trạng thái run và task

| | Giá trị |
| --- | --- |
| Run | `queued`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `cancelling`, `cancelled` |
| Task | `pending`, `ready`, `running`, `waiting`, `retrying`, `blocked`, `succeeded`, `failed`, `cancelling`, `cancelled` |

Mỗi task có `attempt` (tăng đơn điệu trong cả run), `generation` (số lần rework), `attemptId`, `agentExecution` (handle đã bind) và `blockage` (`code`: `waiting_dependency`, `awaiting_approval`, `agent_unavailable`, `external_dependency`, `quality_gate`, `manual_intervention`).

### Qua RuntimeService

```ts
const run = await service.getRun("feat-001");          // OperationResult<WorkflowRunSnapshot | null>
const page = await service.findRuns({ status: ["blocked"], limit: 50 });
```

- `getRun` ưu tiên snapshot trong bộ nhớ của engine, nếu không có thì đọc projection trong RunStore.
- `getRun` trả `status: "blocked"` khi run đang `running` nhưng có task `blocked` và không còn task `running`/`ready`/`retrying`.
- Khi đang chờ một approval mở, run vẫn có thể hiển thị `running`; xem approval đang mở qua event (bên dưới).

### Theo dõi event trực tiếp

```ts
const controller = new AbortController();
for await (const item of service.watch("feat-001", { afterSequence: 0, signal: controller.signal })) {
  if (!item.ok) { console.error(item.error); break; }
  console.log(item.value.sequence, item.value.type, item.value.taskId ?? "");
}
```

`watch` phát lại event đã lưu rồi tiếp tục với event mới trong cùng tiến trình; stream kết thúc khi run ở trạng thái kết thúc.

### Đọc trực tiếp từ RunStore

```ts
const stored = await runStore.get("feat-001");                       // { snapshot, definition } — projection để truy vấn
const events = await runStore.readEvents("feat-001", { limit: 200 });  // trang; tiếp theo bằng { cursor: events.value.nextCursor }
const checkpoint = await runStore.loadLatestCheckpoint("feat-001");
```

`runStore.get().snapshot` là projection phục vụ truy vấn, **không** phải trạng thái aggregate để ra quyết định; event và aggregate checkpoint mới là nguồn sự thật.

## Event quan trọng

| Event | Ý nghĩa |
| --- | --- |
| `run.created`, `run.status_changed` | Vòng đời run |
| `task.status_changed` | Mọi chuyển trạng thái task (kèm lý do) |
| `agent.execution_bound` | Prompt được transport chấp nhận và handle đã lưu bền |
| `agent.delivery_reconciled`, `agent.delivery_uncertain` | Kết quả reconcile khi giao prompt không chắc chắn |
| `agent.result_recorded` | Kết quả đã xác minh; `payload.output.artifactIds` liệt kê artifact đã lưu |
| `task.retry_scheduled` | Retry với `payload.eligibleAt` |
| `approval.requested`, `approval.decided` | Approval; approval đang mở = `requested` chưa có `decided` cùng `approvalId` |
| `quality_gate.evaluation_requested`, `quality_gate.evaluated` | Gate; `payload.status`, `payload.findings`, `payload.metadata` (lệnh, thư mục, exit code, thời gian) |
| `cancellation.requested`, `cancellation.accepted`/`refused`, `cancellation.stop_confirmed` | Hủy |
| `command.completed` | Receipt idempotency của mỗi lệnh |

Runtime hiện không phát `artifact.stored` và `run.checkpoint_saved`; checkpoint được lưu vào bảng checkpoint của RunStore.

## Artifact

```ts
const list = await artifactStore.find({ runId: "feat-001" });            // có thể lọc taskId, kind
const ref = await artifactStore.resolve("plan-doc-1");                   // ArtifactReference | null
if (ref.ok && ref.value) {
  for await (const chunk of artifactStore.get(ref.value)) {
    if (!chunk.ok) throw new Error(chunk.error.message);
    process.stdout.write(chunk.value);
  }
}
```

`get` chỉ trả byte sau khi đã kiểm tra toàn bộ size/checksum. Không bao giờ ghép `artifactId` hay `uri` thành đường dẫn file.

| Artifact | Nguồn |
| --- | --- |
| `proposalId` bạn gửi trong `completeTaskExecution` | Output của agent sau khi được ingest |
| `report-<runId>-handoff` | Báo cáo handoff Markdown do Runtime sinh khi task cần approval hoặc khi mọi task thành công |

Giới hạn hiện tại:

- Báo cáo handoff dùng idempotency key cố định theo run, nên nó **giữ nội dung của lần sinh đầu tiên** (thường là lúc review chờ approval), không cập nhật trạng thái cuối. Kiểm tra trạng thái cuối bằng `getRun`/event.
- Bằng chứng của quality gate (`ArtifactProposal` chứa stdout/stderr) nằm trong `payload.producedArtifacts` của `quality_gate.evaluated` nhưng **không** được Runtime ghi vào ArtifactStore; chỉ `metadata.evidenceProposalId` và `metadata.evidenceChecksumSha256` được lưu trong event.

## Bố cục trên đĩa (demo)

```text
<DIR>/runs.sqlite      RunStore (WAL)
<DIR>/artifacts/       catalog.sqlite + blob-<uuid>
<DIR>/registry.json    AgentRegistry (+ registry.json.lock khi đang thao tác)
<DIR>/outbox/          prompt do OutboxTransport ghi (chỉ có trong demo)
```

Sao lưu SQLite theo cách nhất quán (bao gồm WAL), không chỉ chép file chính khi đang ghi.
