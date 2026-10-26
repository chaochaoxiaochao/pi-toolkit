// Native Pi lifecycle regression with an offline provider; no Herdr panes or paid requests.
import "./runtime.mjs";
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager}=await import('@earendil-works/pi-coding-agent');
const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
const {default:childReport}=await import('../extensions/subagent-report.ts');
// Real Pi lifecycle, offline provider. No Herdr panes, no delegated model, no network.
delete process.env.HERDR_ENV;delete process.env.HERDR_SOCKET_PATH;
const root=mkdtempSync(join(tmpdir(),'pi-native-settled-review-'));
process.env.PI_CODING_AGENT_DIR=root;
const cases=['reported','failed_report','remind_success','normal_no_report','transient_retry','retry_exhausted','queued_followup','boundary_continue','abort','settled_hook_new_prompt'];
try{
 for(const scenario of cases){
  const dir=join(root,scenario);mkdirSync(dir);
  const attemptId=randomUUID();const statePath=join(dir,'attempts',attemptId+'.json');
  process.env.PI_HERDR_SUBAGENTS_TASK_DIR=dir;
  if(scenario==='abort'){mkdirSync(join(dir,'.pi'));writeFileSync(join(dir,'.pi','herdr-subagents.json'),JSON.stringify({abortGraceSeconds:1}));}
  writeFileSync(join(dir,'task.json'),JSON.stringify({currentAttemptId:attemptId}));
  const trace=[],states=[],errors=[],inputs=[];let requests=0,ended=0,boundaries=0,settled=0;
  const entered=Promise.withResolvers();let session;
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),refreshOnCreate:false});
  runtime.registerProvider('review',{name:'Offline lifecycle fixture',baseUrl:'http://127.0.0.1:1',api:'review',apiKey:'fixture-not-secret',models:[{id:'offline',name:'Offline',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
   streamSimple(model,context,options){
    inputs.push(structuredClone(context.messages));requests++;const index=requests;trace.push('request:'+index);entered.resolve();const stream=createAssistantMessageEventStream();
    void(async()=>{
     let reason='stop',error;
     if(scenario==='abort'){if(!options.signal.aborted)await new Promise(r=>options.signal.addEventListener('abort',r,{once:true}));reason='aborted';error='Request was aborted';}
     else if((scenario==='transient_retry'&&index===1)||scenario==='retry_exhausted'){reason='error';error='500 Internal Server Error';}
     const reportNow=scenario==='reported'||scenario==='failed_report'||(scenario==='remind_success'&&index===2);
     const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:reportNow?[{type:'toolCall',id:'fixture-report',name:'subagent_report',arguments:{status:scenario==='failed_report'?'failed':'completed',summary:'Offline test report',result:'Offline complete result'}}]:reason==='stop'?[{type:'text',text:'A normal final answer without subagent_report'}]:[],stopReason:reportNow?'toolUse':reason,...(error?{errorMessage:error}:{}),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
     stream.push({type:'start',partial:message});
     stream.push(reason==='stop'?{type:'done',reason:message.stopReason,message}:{type:'error',reason,error:message});
    })().catch(e=>{console.error(e);process.exitCode=1});return stream;
   }
  });
  const settingsManager=SettingsManager.inMemory({retry:{enabled:true,maxRetries:1,baseDelayMs:1,maxDelayMs:1},compaction:{enabled:false},cacheWarming:'off'});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[childReport,pi=>{
   pi.on('before_agent_start',()=>trace.push('before_agent_start'));
   pi.on('agent_start',()=>trace.push('agent_start'));
   pi.on('agent_end',()=>{trace.push('agent_end');ended++;if(scenario==='queued_followup'&&ended===1)pi.sendUserMessage('Queued followup',{deliverAs:'followUp'});});
   pi.on('agent_before_settle',event=>{trace.push('before_settle:'+event.outcome);boundaries++;if(scenario==='boundary_continue'&&boundaries===1)return {entries:[...event.entries,{type:'custom_message',customType:'review',content:'One continuation',display:false}],continue:true};});
   pi.on('agent_settled',(event,ctx)=>{settled++;trace.push('agent_settled:'+event.aborted);states.push({aborted:event.aborted,idle:ctx.isIdle(),file:JSON.parse(readFileSync(statePath,'utf8')),requests});if(scenario==='settled_hook_new_prompt'&&settled===1)pi.sendUserMessage('New prompt from settlement hook');});
  }]});
  await loader.reload();
  session=(await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel('review','offline'),resourceLoader:loader,settingsManager,sessionManager:SessionManager.create(dir,dir),tools:['subagent_report']})).session;
  session.extensionRunner.onError(e=>errors.push(e));
  try{
   await session.bindExtensions({});
   const running=session.prompt('Run offline lifecycle check');
   if(scenario==='abort'){await entered.promise;await session.abort();}
   await running;
   if(scenario==='abort'){assert.equal(existsSync(join(dir,'reports',attemptId+'.json')),false,'no report inside the grace period');await new Promise(r=>setTimeout(r,1500));}
   assert.equal(errors.length,0,JSON.stringify(errors));
   const expectedRequests={reported:1,failed_report:1,remind_success:2,normal_no_report:2,transient_retry:3,retry_exhausted:2,queued_followup:3,boundary_continue:2,abort:1,settled_hook_new_prompt:3}[scenario];
   assert.equal(requests,expectedRequests,scenario);
   assert.equal(settled,scenario==='settled_hook_new_prompt'?2:1,scenario);
   assert.ok(states.every(s=>s.aborted===(scenario==='abort')));
   const report=JSON.parse(readFileSync(join(dir,'reports',attemptId+'.json'),'utf8'));
   assert.equal(report.status,['reported','remind_success'].includes(scenario)?'completed':'failed');
   if(['abort','retry_exhausted'].includes(scenario))assert.equal(inputs.some(input=>JSON.stringify(input).includes('Do not redo the task')),false);
   if(!['reported','failed_report','remind_success'].includes(scenario))assert.ok(report.documents.some(document=>document.path===session.sessionManager.getSessionFile()));
   if(scenario==='remind_success')assert.ok(JSON.stringify(inputs[1]).includes('Do not redo the task'));
   assert.ok(trace.indexOf('agent_end')<trace.indexOf('before_settle:completed')||['abort','retry_exhausted'].includes(scenario));
   console.log(JSON.stringify({scenario,requests,agentEnds:ended,settledEvents:settled,trace,states:states.map(({file,...s})=>({...s,fileState:file.state})),reportExists:existsSync(join(dir,'reports',attemptId+'.json'))}));
  }finally{await session.abort();await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
 }
}finally{rmSync(root,{recursive:true,force:true});}
