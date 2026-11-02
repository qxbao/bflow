import { explain } from '../api/client';
export type ReadProblem={label:string;error:unknown;stale:boolean};
/** One failure reported by several reads is one incident: one notice, one retry, the affected areas listed. */
export function ReadProblems({problems,retry}:{problems:ReadProblem[];retry:()=>void}) {
  const groups=new Map<string,ReadProblem[]>();
  for(const problem of problems){const key=explain(problem.error);groups.set(key,[...(groups.get(key)??[]),problem]);}
  if(!groups.size)return null;
  return <section className="my-4 border border-line border-l-3 border-l-danger bg-surface p-4" role="alert"><h2>Chưa tải được dữ liệu</h2>{[...groups].map(([message,items])=><div key={message}><p>{message}</p><p className="text-sm text-muted">Ảnh hưởng: {items.map(item=>item.label).join(', ')}.{items.some(item=>item.stale)?' Dữ liệu đang hiện đã cũ, chỉ tham khảo cho đến khi tải lại thành công.':''}</p></div>)}<button onClick={retry}>Thử tải lại</button></section>;
}
