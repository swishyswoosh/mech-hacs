import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(config){
 const replies=[],calls=[];let Panel;
 const child={postMessage:(message,origin)=>replies.push({message,origin})};
 const document={hidden:false,createElement:tag=>tag==='iframe'?{contentWindow:child}:{},addEventListener(){},removeEventListener(){}};
 class Element{attachShadow(){this.shadowRoot={append(){}};}}
 const context={HTMLElement:Element,document,window:{addEventListener(){},removeEventListener(){}},location:{origin:'https://home.test'},customElements:{get(){},define(_name,component){Panel=component;}}};
 vm.runInNewContext(readFileSync(new URL('../../custom_components/mech/panel.js',import.meta.url),'utf8'),context);
 const panel=new Panel();panel.panel={config};panel.hass={user:{is_admin:true},callWS:async message=>{calls.push(JSON.parse(JSON.stringify(message)));return {status:200,body:{items:[]}};}};panel.connectedCallback();
 const request=(id='test',path='droids',body)=>({origin:'https://home.test',source:child,data:{type:'mech:request',id,request:{type:'untrusted/arbitrary',path,method:body?'POST':'GET',...(body?{body}:{})}}});
 return {panel,calls,replies,child,request};
}
test('HA host accepts only its own iframe and forwards a fixed authenticated command',async()=>{
 const f=fixture();await f.panel.receive({...f.request(),origin:'https://evil.test'});await f.panel.receive({...f.request(),source:{}});assert.equal(f.calls.length,0);
 await f.panel.receive(f.request());assert.deepEqual(f.calls,[{type:'mech/request',path:'droids',method:'GET'}]);
 assert.equal(f.replies[0].origin,'https://home.test');assert.equal(f.panel.frame.src,'/mech/controller/index.html?ha=1');
});
test('new builds bypass cached controller HTML without reloading an existing iframe',()=>{
 const f=fixture({controller_version:'build-a'});
 assert.equal(f.panel.frame.src,'/mech/controller/index.html?ha=1&v=build-a');
 const frame=f.panel.frame;
 f.panel.panel={config:{controller_version:'build-b'}};
 f.panel.connectedCallback();
 assert.equal(f.panel.frame,frame);
 assert.equal(frame.src,'/mech/controller/index.html?ha=1&v=build-a');
});
test('HA host denies nonadmin access and teardown releases a tracked controller without disconnect',async()=>{
 const f=fixture();const body={client_id:'tab',droid_id:'r2',visible:true};await f.panel.receive(f.request('beat','ui/heartbeat',body));
 await f.panel.release();assert.deepEqual(f.calls.at(-1),{type:'mech/request',method:'POST',path:'ui/release',body:{droid_id:'r2',client_id:'tab'}});
 const count=f.calls.length;f.panel.hass={user:{is_admin:false},callWS:()=>{throw Error('Must not dispatch');}};await f.panel.receive(f.request());
 assert.equal(f.calls.length,count);assert.equal(f.replies.at(-1).message.response.status,503);
 assert.ok(!JSON.stringify(f.calls).includes('connection.disconnect'));
});
