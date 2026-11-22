// Published parent implementation + real Herdr; model responses are synthetic loopback SSE.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [packagePath, workRoot, evidencePath, configPath] = process.argv.slice(2);
assert.ok(packagePath && workRoot && evidencePath && configPath);
assert.equal(process.env.PI_CODING_AGENT_DIR, configPath);
const selfTest = process.env.ISSUE32_PROVIDER_SELFTEST === "1";
if (!selfTest) {
 assert.equal(process.env.HERDR_ENV, "1");
 assert.ok(process.env.HERDR_WORKSPACE_ID);
}
const { runHerdrSubagentsBatch } = await import(pathToFileURL(join(packagePath, "src/batch-runner.ts")));
const { CliHerdrAutomation } = await import(pathToFileURL(join(packagePath, "src/herdr.ts")));
const events = [];
let began=performance.now(), round=0, requests=0;
function event(name, data={}) {
 events.push({round, ms:Math.round(performance.now()-began), event:name,...data});
 writeFileSync(evidencePath, JSON.stringify(events,null,2));
}
const provider = createServer(async (req,res)=>{
 try {
  if(req.method!=="POST" || req.url!=="/v1/chat/completions"){res.writeHead(404).end();return;}
  let body="";
  for await(const chunk of req) body+=chunk;
  const toolNames=(JSON.parse(body).tools??[]).map(x=>x.function?.name);
  requests++;
  event("offline-provider-reached",{toolNames});
  if(!toolNames.includes("subagent_report")){res.writeHead(400).end(JSON.stringify({error:{message:"Expected subagent_report"}}));return;}
  const tell=(choice,usage)=>res.write("data: "+JSON.stringify({id:"offline-completion",created:1,model:"issue32-fixture",object:"chat.completion.chunk",choices:[{index:0,...choice}],...(usage?{usage}:{})})+"\n\n");
  res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
  tell({delta:{role:"assistant",tool_calls:[{index:0,id:"offline_report",type:"function",function:{name:"subagent_report",arguments:JSON.stringify({status:"completed",summary:"offline smoke complete",result:"Synthetic result",documents:[]})}}]},finish_reason:null});
  tell({delta:{},finish_reason:"tool_calls"},{prompt_tokens:1,completion_tokens:1,total_tokens:2});
  res.end("data: [DONE]\n\n");
 }catch(err){event("offline-provider-error",{error:String(err)});res.end();}
});
await new Promise((resolve,reject)=>{provider.once("error",reject);provider.listen(0,"127.0.0.1",resolve)});
const model="mac-smoke/issue32-fixture";
const cfg={providers:{"mac-smoke":{baseUrl:"http://127.0.0.1:"+provider.address().port+"/v1",apiKey:"fixture-not-a-secret",api:"openai-completions",models:[{id:"issue32-fixture",name:"Issue 32 offline fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:2048}]}}};
mkdirSync(configPath,{recursive:true});
writeFileSync(join(configPath,"models.json"),JSON.stringify(cfg));
try {
 if(selfTest){
  const attemptId=randomUUID();
  writeFileSync(join(workRoot,"task.json"),JSON.stringify({currentAttemptId:attemptId}));
  const child=spawn("pi",["--approve","--no-extensions","--no-skills","--extension","builtin:codemode","--extension",join(packagePath,"extensions/subagent-report.ts"),"--model",model,"--tools","read,codemode,subagent_report","--session",join(workRoot,"session.jsonl"),"-p","Submit an offline smoke report."],{cwd:workRoot,env:{...process.env,PI_HERDR_SUBAGENTS_TASK_DIR:workRoot,HERDR_ENV:"0"},stdio:"inherit",signal:AbortSignal.timeout(20000)});
  await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",code=>code===0?resolve():reject(Error("Pi self-test exit "+code)));});
  assert.equal(JSON.parse(readFileSync(join(workRoot,"reports",attemptId+".json"),"utf8")).status,"completed");
  assert.ok(requests);
  event("offline-provider-selftest-passed");
 }
 const failures=[];
 for(round=1;!selfTest && round<=Number(process.env.ISSUE32_ROUNDS??3);round++){
  began=performance.now();
  const requestsBefore=requests;
  const herdr=new CliHerdrAutomation();
  for(const method of ["startAgent","promptAgent","isTaskRunning"]){
   const original=herdr[method].bind(herdr);
   let seen=0;
   herdr[method]=async (...args)=>{
    const poll=++seen;
    if(method!=="isTaskRunning" || poll<=4) event(method+"-begin",{poll});
    try{
     const result=await original(...args);
     if(method!=="isTaskRunning" || poll<=4) event(method+"-end",{poll,...(typeof result==="boolean"?{alive:result}:{status:result?.status,interactiveReady:result?.interactive_ready})});
     return result;
    }catch(err){event(method+"-error",{poll,error:String(err)});throw err;}
   };
  }
  try{
   const result=await runHerdrSubagentsBatch([{name:"probe",agent:"explorer",access:"read",tools:["read"],skills:[],extensions:[],prompt:"Submit an offline smoke report.",systemPrompt:"Use subagent_report.",model}],{label:"issue32-baseline",concurrency:1,maxConcurrency:1,cwd:workRoot,herdr,signal:AbortSignal.timeout(45000)});
   const [task]=result.tasks;
   const record=task?JSON.parse(readFileSync(join(task.recordDirectory,"task.json"),"utf8")):{};
   const reportFile=task?join(task.recordDirectory,"report.json"):"";
   const report=existsSync(reportFile)?JSON.parse(readFileSync(reportFile,"utf8")):{};
   event("settled",{status:result.status,error:task?.error,attemptIdPresent:!!record.currentAttemptId,attemptMatched:!!record.currentAttemptId&&record.currentAttemptId===report.attemptId,requests:requests-requestsBefore,sessionWritten:!!task&&existsSync(task.sessionFile)});
   assert.equal(result.status,"completed",task?.error);
   assert.equal(record.currentAttemptId,report.attemptId);
   assert.ok(record.currentAttemptId && requests>requestsBefore);
  }catch(err){failures.push("round "+round+": "+err.message);event("failed",{error:String(err)});}
 }
 if(failures.length) throw new Error(failures.join("; "));
} finally {
 provider.closeAllConnections();
 await new Promise(resolve=>provider.close(resolve));
}
