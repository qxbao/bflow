import { randomUUID } from 'node:crypto';
import { WebEventSchema, WebEventCursorSchema, WebPageSchema, WEB_LIMITS, type WebEvent } from '@bflow/contracts';
/** Ephemeral presentation invalidations. Never a domain event journal or delivery receipt. */
export class ProjectionFeed {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private ring: WebEvent[] = [];
  constructor(private readonly projectId: string, private readonly capacity: number = WEB_LIMITS.eventsPerProject) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > WEB_LIMITS.eventsPerProject) throw Error('Invalid feed bound');
  }
  get size(): number { return this.ring.length; }
  publish(type: WebEvent['type'], resourceIds: string[]): WebEvent {
    const value = WebEventSchema.parse({apiVersion:1,projectId:this.projectId,cursor:`${this.epoch}:${++this.sequence}`,type,resourceIds,occurredAt:new Date().toISOString()});
    this.ring.push(value); if(this.ring.length>this.capacity)this.ring.shift(); return structuredClone(value);
  }
  read(cursor?: string) {
    const parsed=WebEventCursorSchema.safeParse(cursor);
    const [epoch, raw] = parsed.success ? parsed.data.split(':') : [];
    const sequence = raw === undefined ? -1 : Number(raw);
    const first = this.ring[0];
    const oldest = first ? Number(first.cursor.split(':')[1]) : this.sequence+1;
    const reset = !parsed.success || epoch!==this.epoch || !Number.isSafeInteger(sequence) || sequence < oldest-1 || sequence>this.sequence;
    return WebPageSchema(WebEventSchema).parse({apiVersion:1,items:reset ? [{apiVersion:1,projectId:this.projectId,cursor:`${this.epoch}:${this.sequence}`,type:'reset',resourceIds:[],occurredAt:new Date().toISOString()}] : this.ring.filter(e=>Number(e.cursor.split(':')[1])>sequence).slice(0,100)});
  }
}
