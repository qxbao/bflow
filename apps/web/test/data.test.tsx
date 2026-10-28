import { afterEach, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRead } from '../src/features/data';
afterEach(cleanup);
it('allows an in-flight snapshot to finish when newer invalidations arrive',async()=>{
 let resolveRead:(value:string)=>void=()=>{};
 const pending=new Promise<string>(resolve=>{resolveRead=resolve;});
 let calls=0;const load=()=>++calls===1?pending:new Promise<string>(()=>{});
 function Probe({revision}:{revision:number}){const result=useRead('run',load,revision);return <p>{result.data??'loading'}</p>;}
 const view=render(<Probe revision={1}/>);view.rerender(<Probe revision={2}/>);view.rerender(<Probe revision={3}/>);
 await act(async()=>{resolveRead('authoritative snapshot');await pending;});
 expect(await screen.findByText('authoritative snapshot')).toBeTruthy();
});
