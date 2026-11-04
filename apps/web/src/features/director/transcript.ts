import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectorMessage, WebDirectorTranscriptPage } from '@bflow/contracts/web';
import { useDirector } from './status';

/**
 * Project-scoped Director transcript (both channels, both authors) built from the server's private cursor convention:
 * no cursor = latest page (≤100, no backward cursor), `a<highest contiguous seq>` = newer, `b<first-seq>` = older. Items are merged by seq;
 * a seq or message ID that changes identity, or a view whose transcriptSeq is behind what we hold, means the transcript was
 * reset/restarted and the latest page is reloaded. Reads never acknowledge anything.
 */
export const TRANSCRIPT_PAGE=100;
const MAX_NEWER_PAGES=20;
export class TranscriptReset extends Error {}
/** Merges pages by seq; throws TranscriptReset when an existing seq/messageId changes identity. */
export function mergeTranscript(current:readonly DirectorMessage[],incoming:readonly DirectorMessage[]):DirectorMessage[]{
  const bySeq=new Map(current.map(item=>[item.seq,item])),byId=new Map(current.map(item=>[item.messageId,item.seq]));
  for(const item of incoming){
    const old=bySeq.get(item.seq),seq=byId.get(item.messageId);
    if((old&&old.messageId!==item.messageId)||(seq!==undefined&&seq!==item.seq))throw new TranscriptReset('transcript identity changed');
    bySeq.set(item.seq,item);byId.set(item.messageId,item.seq);
  }
  return [...bySeq.values()].sort((a,b)=>a.seq-b.seq);
}
export type TranscriptState={items:DirectorMessage[];loaded:boolean;loading:boolean;loadingOlder:boolean;hasOlder:boolean;error?:unknown;olderError?:unknown};
const initial:TranscriptState={items:[],loaded:false,loading:false,loadingOlder:false,hasOlder:false};
const older=(page:WebDirectorTranscriptPage)=>page.items.length>=TRANSCRIPT_PAGE&&page.items[0]!.seq>1;
/**
 * Highest seq held without a gap from the first held item. Store seqs are contiguous, so a later item (e.g. our own send
 * result merged ahead of an unseen Director reply) must not move the `a<seq>` cursor past the missing seqs.
 */
export function contiguousSeq(items:readonly DirectorMessage[]):number{
  let last=items[0]?.seq??0;
  for(let i=1;i<items.length&&items[i]!.seq===last+1;i++)last=items[i]!.seq;
  return last;
}

export function useDirectorTranscript(enabled:boolean){
  const d=useDirector(),projectId=d.projectId;
  // The client is read through a ref: only project scope, enablement and an SSE reset restart the transcript.
  const client=useRef(d.api);client.current=d.api;
  const [state,setState]=useState<TranscriptState>(initial);
  const items=useRef<DirectorMessage[]>([]),loaded=useRef(false),generation=useRef(0),queue=useRef<Promise<void>>(Promise.resolve());
  const commit=useCallback((patch:Partial<TranscriptState>)=>setState(old=>({...old,...patch,items:items.current,loaded:loaded.current})),[]);
  /** Operations run one at a time; a result from an older generation (project change, reset) is discarded. */
  const run=useCallback((work:(gen:number)=>Promise<void>)=>{
    const gen=generation.current;
    queue.current=queue.current.then(()=>gen===generation.current?work(gen):undefined).catch(()=>undefined);
    return queue.current;
  },[]);
  const latest=useCallback((gen:number)=>(async()=>{
    commit({loading:true});
    try{
      const page=await client.current.directorMessages(projectId);
      if(gen!==generation.current)return;
      items.current=page.items;loaded.current=true;commit({loading:false,hasOlder:older(page),error:undefined});
    }catch(error){if(gen===generation.current)commit({loading:false,error});}
  })(),[projectId,commit]);
  const newer=useCallback(async(gen:number)=>{
    if(!loaded.current)return latest(gen);
    commit({loading:true});
    try{
      for(let pageIndex=0;pageIndex<MAX_NEWER_PAGES;pageIndex++){
        const after=contiguousSeq(items.current);
        const page=await client.current.directorMessages(projectId,`a${after}`);
        if(gen!==generation.current)return;
        if(page.items.some(item=>item.seq<=after))throw new TranscriptReset('newer page went backwards');
        items.current=mergeTranscript(items.current,page.items);
        if(page.items.length<TRANSCRIPT_PAGE)break;
      }
      commit({loading:false,error:undefined});
    }catch(error){
      if(gen!==generation.current)return;
      if(error instanceof TranscriptReset){loaded.current=false;return latest(gen);}
      commit({loading:false,error});
    }
  },[projectId,commit,latest]);
  const resetTo=useCallback(()=>{generation.current++;items.current=[];loaded.current=false;setState(initial);void run(latest);},[run,latest]);

  // Project scope, enablement and SSE reset: start again from the latest page.
  useEffect(()=>{if(enabled)resetTo();else{generation.current++;items.current=[];loaded.current=false;setState(initial);}},[enabled,projectId,d.resetEpoch,resetTo]);
  // Every refresh signal (SSE chat/invalidate → revision, local reload) polls newer pages only.
  const firstEpoch=useRef(true);
  useEffect(()=>{if(firstEpoch.current){firstEpoch.current=false;return;}if(enabled)void run(newer);},[d.readEpoch]);// eslint-disable-line react-hooks/exhaustive-deps
  // The view's transcriptSeq is the server's high-water mark: behind ours means a reset/restart, ahead means unread messages.
  const seq=d.error===undefined?d.view?.transcriptSeq:undefined;
  useEffect(()=>{
    if(!enabled||seq===undefined||!loaded.current)return;
    const last=items.current.at(-1)?.seq??0;
    if(seq<last){generation.current++;loaded.current=false;void run(latest);}
    else if(seq>contiguousSeq(items.current))void run(newer);
  },[seq,enabled]);// eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder=useCallback(()=>run(async gen=>{
    const first=items.current[0]?.seq;if(first===undefined||first<=1){commit({hasOlder:false});return;}
    commit({loadingOlder:true,olderError:undefined});
    try{
      const page=await client.current.directorMessages(projectId,`b${first}`);
      if(gen!==generation.current)return;
      if(page.items.some(item=>item.seq>=first))throw new TranscriptReset('older page went forwards');
      items.current=mergeTranscript(items.current,page.items);commit({loadingOlder:false,hasOlder:Boolean(page.nextCursor)});
    }catch(error){if(gen===generation.current)commit({loadingOlder:false,olderError:error});}
  }),[projectId,run,commit]);
  /** A message the server just returned for our own send: shown at once, then confirmed by the next page. */
  const append=useCallback((message:DirectorMessage)=>{
    try{items.current=mergeTranscript(items.current,[message]);commit({});}catch{void run(latest);}
    void run(newer);
  },[commit,run,latest,newer]);
  const refresh=useCallback(()=>run(newer),[run,newer]);
  return {...state,loadOlder,append,refresh};
}
export type DirectorTranscript=ReturnType<typeof useDirectorTranscript>;
