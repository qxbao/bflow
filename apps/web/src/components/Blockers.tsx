import type { WebBlocker } from '@bflow/contracts/web';
import { reason, severity, severityLabels, type Severity } from './reasons';
const tones:Record<Severity,string>={action:'border-danger',degraded:'border-line',checking:'border-steel'};
const order:Severity[]=['action','checking','degraded'];
/** Required action, optional degradation and in-progress checks must not read as the same failure. */
export function Blockers({items}:{items:WebBlocker[]}) {
  const unique=[...new Map(items.map(item=>[item.code,item])).values()].sort((a,b)=>order.indexOf(severity(a.code))-order.indexOf(severity(b.code)));
  return <>{unique.map(item=><p key={item.code} className={`my-3 border-l-3 pl-3 text-sm ${tones[severity(item.code)]}`}><span className="font-data font-semibold">{severityLabels[severity(item.code)]}: </span>{reason(item.code)}</p>)}</>;
}
