// Run the repository's release gate under real Herdr with an offline model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [packagePath, _workRoot, evidencePath, configPath] = process.argv.slice(2);
assert.ok(packagePath && evidencePath && configPath);
assert.equal(process.env.HERDR_ENV, "1");
assert.ok(process.env.HERDR_WORKSPACE_ID);
const root=resolve(packagePath,"../..");
const events=[];
let requests=0;
function event(event, extra={}) {
 events.push({event,...extra});
 writeFileSync(evidencePath,JSON.stringify(events,null,2));
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
 const child=spawn("bash",["scripts/release-check.sh","herdr-subagents"],{
  cwd:root,env:{...process.env,HERDR_SUBAGENTS_E2E_MODEL:model,HERDR_SUBAGENTS_E2E_FOCUS_CLEANUP:"1"},stdio:"inherit",signal:AbortSignal.timeout(150000),
 });
 const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
 event("release-check-settled",{code,requests});
 assert.equal(code,0);
 assert.ok(requests>=3,"The native serial and concurrent Herdr cases must reach the offline model.");
} finally {
 provider.closeAllConnections();
 await new Promise(resolve=>provider.close(resolve));
}
