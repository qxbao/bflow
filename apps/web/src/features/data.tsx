import { useEffect, useRef, useState } from 'react';
export function useRead<T>(key:string, load:()=>Promise<T>, revision:number) {
  const [result,setResult]=useState<{key:string;data?:T;error?:unknown;loading:boolean}>({key,loading:true});
  const loader=useRef(load);loader.current=load;
  const trigger=useRef<()=>void>(()=>{}),lastRevision=useRef(revision);
  useEffect(()=>{
    let active=true,running=false,dirty=false;
    const read=()=>{
      if(!active)return;
      if(running){dirty=true;return;}
      running=true;
      setResult(old=>old.key===key?{...old,loading:true}:{key,loading:true});
      void loader.current().then(data=>{
        if(active)setResult({key,data,loading:false});
      },error=>{
        if(active)setResult(old=>({...old,key,error,loading:false}));
      }).finally(()=>{
        running=false;
        if(active && dirty){dirty=false;read();}
      });
    };
    trigger.current=read;read();
    return()=>{active=false;};
  },[key]);
  useEffect(()=>{if(lastRevision.current!==revision){lastRevision.current=revision;trigger.current();}},[revision]);
  return result.key===key?result:{key,loading:true};
}
