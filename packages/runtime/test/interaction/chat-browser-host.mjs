// Test-only bridge: real durable chat code with explicitly synthetic transport.
import { HostChat } from '../../dist/interaction/chat.js';
let chat;const wires=[];let busy=false;const options={directory:process.env.W08_CHAT_DIRECTORY,projectId:'project',hostSessionId:'fixture-host',
 session:async()=>({sessionId:'fixture-host',nativeSessionId:'native-fixture',paneId:'fixture-pane',provider:'claude',ready:true,busy}),
 prompt:async wire=>{wires.push(wire);},admit:async id=>({messageId:id})};
chat=new HostChat(options);
process.on('message',async raw=>{try{
 let value;
 if(raw.kind==='send')value=await chat.send({...raw.input,projectId:'project'},'fixture-user');
 else if(raw.kind==='list')value=await chat.list('fixture-host',raw.cursor);
 else if(raw.kind==='echo'){for(const wire of wires)await chat.echo({nativeSessionId:'native-fixture',paneId:'fixture-pane',prompt:wire});value=true;}
 else if(raw.kind==='restart'){chat=new HostChat(options);await chat.pump();value=true;}
 else if(raw.kind==='busy'){busy=raw.busy;await chat.pump();value=true;}
 else if(raw.kind==='inspect')value={wires:wires.length};
 process.send({id:raw.id,value});
}catch{process.send({id:raw.id,error:'Synthetic chat bridge refused input'});}});
