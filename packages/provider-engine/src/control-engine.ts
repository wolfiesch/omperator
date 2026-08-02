import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JsonValue, ProviderControlLedger, TicketBinding } from "@t4-code/portable-control-store";
import type { RuntimeCreate, ScopeId, WorkspaceCreate } from "@t4-code/portable-core";
import type { ResourceDriver } from "@t4-code/portable-driver";
import { decodeProviderRequestFrame, encodeProviderFailure, encodeProviderSuccess, MAX_CONTROL_FRAME_BYTES, PROVIDER_ACTION_TARGETS_CLIENT_CAPABILITY, type ProviderError, type ProviderMethod, type ProviderRequestEnvelope, type WireValue } from "./machine-provider-v1.js";
import type { ProviderConnectionRegistry, ProviderGenerationInstallOutcome } from "./connection-registry.js";
import { PROVIDER_STREAM_AUDIENCE, PROVIDER_STREAM_PURPOSE, type ProviderAuthorizationOutcome, type ProviderAuthorizationRequest, type ProviderIngressIdentity } from "./stream-engine.js";

const ADVERTISED_CAPABILITIES=["client-capability-negotiation-v1"] as const;
const ACTION_BY_METHOD:Record<ProviderMethod,readonly string[]>={hello:["scope.read"],negotiate_client_capabilities:["scope.read"],subscribe_notices:["runtime.read"],acknowledge_notice:["runtime.read"],snapshot:["runtime.read"],open_machine:["runtime.connect.cmux"],select_scope:["scope.read"],create_machine:["runtime.create"],connect_external_machine:["runtime.create"],machine_lifecycle_snapshot:["runtime.read"],rename_machine:["scope.admin"],delete_machine:["runtime.delete","destructive.confirmation"],restore_machine:["runtime.create"],purge_machine:["runtime.purge","destructive.confirmation"],create_workspace:["workspace.create"],workspace_snapshot:["workspace.read"],rename_workspace:["workspace.update"],delete_workspace:["workspace.delete","destructive.confirmation"],restore_workspace:["workspace.update"],purge_workspace:["workspace.purge","destructive.confirmation"],invoke_action:[],close_machine:["runtime.stop"]};
const INVOKE_ACTIONS:Readonly<Record<string,string>>={wake:"runtime.wake",sleep:"runtime.sleep",stop:"runtime.stop"};
const MAX_WAKE_TIMEOUT_MS=180_000;
const DEFAULT_WAKE_POLL_MS=250;

export interface ProviderCreationPolicy{runtime(request:{scopeId:string;mutationId:string;identity:ProviderIngressIdentity}):Promise<RuntimeCreate&{id?:string}>;workspace(request:{machineId:string;mode:"isolated"|"host";mutationId:string;identity:ProviderIngressIdentity}):Promise<WorkspaceCreate&{id?:string}>}
type ReconciliableProviderControlLedger=ProviderControlLedger&{reconcileIdempotency(request:{readonly principalId:string;readonly scopeId:string;readonly method:string;readonly canonicalPath:string;readonly idempotencyKey:string;readonly canonicalBodyDigest:string;readonly result:JsonValue}):Promise<{readonly outcome:"completed"}|{readonly outcome:"alreadyCompleted";readonly result:JsonValue}|{readonly outcome:"conflict"|"notFound"}>|{readonly outcome:"completed"}|{readonly outcome:"alreadyCompleted";readonly result:JsonValue}|{readonly outcome:"conflict"|"notFound"}};
export interface ProviderMetricsSink {
	increment(name: "omperator_wake_total", labels: Readonly<{ result: "success" | "error" | "timeout" }>): void;
	increment(name: "omperator_provider_ticket_total", labels: Readonly<{ operation: "issue" | "consume" | "revoke"; result: "success" | "error" | "denied" | "timeout" | "fenced" }>): void;
	observe(name: "omperator_provider_snapshot_duration_seconds", value: number, labels: Readonly<{ result: "success" | "error" | "timeout" }>): void;
}
export interface ProviderControlDependencies{readonly providerId:string;readonly providerName:string;readonly driver:ResourceDriver;readonly tickets:ReconciliableProviderControlLedger;readonly connections:ProviderConnectionRegistry;readonly authorize:(request:ProviderAuthorizationRequest)=>Promise<ProviderAuthorizationOutcome>;readonly creationPolicy:ProviderCreationPolicy;readonly metrics?:ProviderMetricsSink;readonly randomBytes?:(length:number)=>Uint8Array;readonly ticketTtlSeconds?:number;readonly wakeTimeoutMs?:number;readonly wakePollIntervalMs?:number;readonly now?:()=>number;readonly sleep?:(milliseconds:number)=>Promise<void>}
type State="awaitHello"|"negotiating"|"active"|"closing"|"closed";
interface Issued{readonly ticket:string;readonly binding:TicketBinding}
const failure=(code:string,message:string,retryable=false):ProviderError=>({code,message,retryable});
type AllowedAuthorization=Extract<ProviderAuthorizationOutcome,{readonly outcome:"allowed"}>;
const record=(v:WireValue):Record<string,WireValue>=>v as Record<string,WireValue>;
const jsonRecord = (value: WireValue | undefined): value is Record<string, WireValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function canonicalWire(value:WireValue):string{
 if(value===null)return"z";
 if(typeof value==="bigint")return`i:${value};`;
 if(typeof value==="number")return`n:${value};`;
 if(typeof value==="boolean")return value?"b:1":"b:0";
 if(typeof value==="string")return`s:${JSON.stringify(value)}`;
 if(Array.isArray(value))return`a:${value.length}:[${value.map(canonicalWire).join(",")}]`;
 if(!jsonRecord(value))throw new TypeError("wire object expected");
 const keys=Object.keys(value).sort();
 return`o:${keys.length}:{${keys.map(key=>`${JSON.stringify(key)}=${canonicalWire(value[key]!)}`).join(",")}}`;
}
const stringField=(r:Record<string,WireValue>,key:string)=>r[key] as string;
const status=(phase:string,desired:string)=>phase==="Ready"&&desired==="Running"?"running":phase==="Starting"||phase==="Creating"?"connecting":desired==="Sleeping"?"sleeping":desired==="Stopped"?"stopped":"unavailable";
export class ProviderControlSession{
 #state:State="awaitHello";#buffer=new Uint8Array();#generation="";#capabilities:readonly string[]=[];#revision=0n;#selectedScope:string|undefined;readonly #issued=new Map<string,Issued>();#queue:Promise<void>=Promise.resolve();
 readonly #deps:ProviderControlDependencies;readonly #identity:ProviderIngressIdentity;readonly #ownerId:string;
 constructor(dependencies:ProviderControlDependencies,identity:ProviderIngressIdentity){if(!dependencies.authorize||!dependencies.creationPolicy)throw new TypeError("authorization and creation policies are mandatory");this.#deps=dependencies;this.#identity=identity;this.#ownerId=`owner_${randomUUID().replaceAll("-","")}`}
 private wakeTimeoutMs():number{const value=this.#deps.wakeTimeoutMs??MAX_WAKE_TIMEOUT_MS;return Number.isSafeInteger(value)&&value>0&&value<=MAX_WAKE_TIMEOUT_MS?value:MAX_WAKE_TIMEOUT_MS}
 private wakePollIntervalMs():number{const value=this.#deps.wakePollIntervalMs??DEFAULT_WAKE_POLL_MS;return Number.isSafeInteger(value)&&value>0&&value<=5_000?value:DEFAULT_WAKE_POLL_MS}
 private now():number{return this.#deps.now?.()??Date.now()}
 private async wait(milliseconds:number):Promise<void>{if(this.#deps.sleep)await this.#deps.sleep(milliseconds);else await new Promise<void>(resolve=>setTimeout(resolve,milliseconds))}

 get providerControlGeneration(){return this.#generation||undefined}
 #enqueue<T>(operation:()=>Promise<T>):Promise<T>{const queued=this.#queue.then(operation,operation);this.#queue=queued.then(()=>undefined,()=>undefined);return queued}
 receive(chunk:Uint8Array):Promise<readonly Uint8Array[]>{return this.#enqueue(()=>this.#receive(chunk))}
 async #receive(chunk:Uint8Array):Promise<readonly Uint8Array[]>{
  if(this.#state==="closed"||this.#state==="closing")return[];
  const joined=new Uint8Array(this.#buffer.byteLength+chunk.byteLength);joined.set(this.#buffer);joined.set(chunk,this.#buffer.byteLength);
  const out:Uint8Array[]=[];let start=0;
  try{
   for(let i=0;i<joined.length;i++){
    if(joined[i]!==10)continue;
    if(i===start)throw new Error("empty control frame");
    if(i-start>MAX_CONTROL_FRAME_BYTES)throw new Error("control frame too large");
    out.push(await this.#handle(decodeProviderRequestFrame(joined.subarray(start,i))));
    start=i+1;
   }
   this.#buffer=joined.subarray(start);
   if(this.#buffer.byteLength>MAX_CONTROL_FRAME_BYTES)throw new Error("control frame too large");
   return out;
  }catch(cause){await this.#close();throw cause}
 }
 finish():Promise<void>{return this.#enqueue(()=>this.#finish())}
 async #finish():Promise<void>{const partial=this.#buffer.byteLength>0;await this.#close();if(partial)throw new Error("control connection ended with a partial frame")}
 close():Promise<void>{return this.#enqueue(()=>this.#close())}
 async #close():Promise<void>{
  if(this.#state==="closed")return;
  this.#state="closing";
  if(this.#generation){
   const released=await this.#deps.connections.releaseControlGeneration({principalId:this.#identity.principalId,generation:this.#generation,ownerId:this.#ownerId});
   if(released.outcome==="released")await this.#revokeBindings(released.bindings,"controlDisconnect",this.#generation);
  }
  this.#issued.clear();
  this.#state="closed";
 }
 async #authorize(request:ProviderRequestEnvelope,generation:string,selectors:ProviderAuthorizationRequest["selectors"],canonicalActions:readonly string[]):Promise<ProviderAuthorizationOutcome>{
  try{return await this.#deps.authorize({identity:this.#identity,method:request.method,canonicalActions,selectors,providerControlGeneration:generation})}catch{return{outcome:"unavailable"}}
 }
 async #handle(request:ProviderRequestEnvelope):Promise<Uint8Array>{
  const params=record(request.params),candidate=request.method==="hello"?createHash("sha256").update(stringField(params,"token")).digest("hex"):this.#generation;
  if(this.#state==="awaitHello"&&request.method!=="hello")return encodeProviderFailure(request.id,failure("invalid_input","hello must be the first request"));
  let canonicalActions=ACTION_BY_METHOD[request.method],invokeInputError:ProviderError|undefined;
  if(request.method==="invoke_action"){
   const target=INVOKE_ACTIONS[stringField(params,"action_id")];
   canonicalActions=target===undefined?[]:[target];
   if(target===undefined)invokeInputError=failure("permission_denied","action target is not enabled");
   else if(typeof params.machine_id!=="string"||params.workspace_id!==undefined)invokeInputError=failure("invalid_input","action requires exactly one machine target");
  }
  const selectors:{scopeId?:string;runtimeId?:string;workspaceId?:string;connectionId?:string;actionId?:string}={};
  if(typeof params.scope_id==="string")selectors.scopeId=params.scope_id;
  if(typeof params.machine_id==="string"){
   selectors.runtimeId=params.machine_id;
   const runtime=this.#deps.driver.getRuntime(params.machine_id);
   if(runtime.outcome==="found")selectors.scopeId=runtime.resource.scopeId;
  }
  if(typeof params.workspace_id==="string"){
   selectors.workspaceId=params.workspace_id;
   if(request.method!=="invoke_action"){
    const workspace=this.#deps.driver.getWorkspace(params.workspace_id);
    if(workspace.outcome==="found")selectors.scopeId=workspace.resource.scopeId;
   }
  }
  if(typeof params.connection_id==="string"){
   selectors.connectionId=params.connection_id;
   const issued=this.#issued.get(params.connection_id);
   if(issued){selectors.scopeId=issued.binding.scopeId;selectors.runtimeId=issued.binding.runtimeId}
  }
  if(typeof params.action_id==="string")selectors.actionId=params.action_id;
  const auth=await this.#authorize(request,candidate,selectors,canonicalActions);
  if(auth.outcome!=="allowed")return encodeProviderFailure(request.id,failure(auth.outcome==="denied"?"permission_denied":auth.outcome==="notFound"?"not_found":"unavailable","request authorization failed",auth.outcome==="unavailable"));
  if(canonicalActions.some(action=>!auth.effectiveCapabilities.includes(action)))return encodeProviderFailure(request.id,failure("permission_denied","required capability is not effective"));
  if(auth.scopeIds.length===0)return encodeProviderFailure(request.id,failure("not_found","no authorized scope is available"));
  if(selectors.scopeId!==undefined&&!auth.scopeIds.includes(selectors.scopeId))return encodeProviderFailure(request.id,failure("not_found","resource was not found"));
  if(request.method!=="hello"&&!(await this.#deps.connections.isCurrentControlGeneration({principalId:this.#identity.principalId,generation:this.#generation,ownerId:this.#ownerId})))return encodeProviderFailure(request.id,failure("unavailable","provider control generation was replaced"));
  if(invokeInputError)return encodeProviderFailure(request.id,invokeInputError);
  if(request.method==="hello"){
   if(this.#state!=="awaitHello")return encodeProviderFailure(request.id,failure("conflict","hello was already received"));
   const client=record(params.client as WireValue),versions=client.supported_versions as readonly WireValue[];
   if(!versions.includes(1))return encodeProviderFailure(request.id,failure("unsupported_version","client does not support version 1"));
   const install=()=>this.#deps.connections.installControlGeneration({principalId:this.#identity.principalId,generation:candidate,ownerId:this.#ownerId});
   let installed:ProviderGenerationInstallOutcome;
   try{installed=await install()}catch(firstError){try{installed=await install()}catch{throw firstError}}
   if(installed.outcome==="alreadyActive")return encodeProviderFailure(request.id,failure("conflict","provider control generation is already active"));
   this.#generation=candidate;this.#state="negotiating";
   if(installed.replaced)await this.#revokeBindings(installed.replaced.bindings,"providerControlGenerationReplacement",installed.replaced.generation);
   return encodeProviderSuccess(request.id,{provider_id:this.#deps.providerId,provider_name:this.#deps.providerName,negotiated_version:1},ADVERTISED_CAPABILITIES);
  }
  if(request.method==="negotiate_client_capabilities"){
   if(this.#state!=="negotiating")return encodeProviderFailure(request.id,failure("conflict","capability negotiation is no longer available"));
   const requested=params.capabilities as readonly string[];
   this.#capabilities=requested.filter(value=>value===PROVIDER_ACTION_TARGETS_CLIENT_CAPABILITY);
   this.#state="active";
   return encodeProviderSuccess(request.id,{capabilities:this.#capabilities});
  }
  if(this.#state==="negotiating")this.#state="active";
  return this.#dispatch(request,params,auth);
 }
 async #dispatch(request:ProviderRequestEnvelope,params:Record<string,WireValue>,authorization:AllowedAuthorization):Promise<Uint8Array>{
  switch(request.method){
   case"snapshot":return encodeProviderSuccess(request.id,await this.#snapshot(authorization));
   case"select_scope":{
    const id=stringField(params,"scope_id"),found=this.#deps.driver.getScope(id);
    if(found.outcome!=="found"||!authorization.scopeIds.includes(id))return encodeProviderFailure(request.id,failure("not_found","scope was not found"));
    this.#selectedScope=id;
    return encodeProviderSuccess(request.id,{snapshot:await this.#snapshot(authorization)});
   }
   case"open_machine":
    if(params.workspace_mirror_authority===true)return encodeProviderFailure(request.id,failure("invalid_input","workspace mirror authority is not supported"));
    return this.#open(request.id,stringField(params,"machine_id"));
   case"close_machine":return this.#closeConnection(request.id,stringField(params,"connection_id"));
   case"create_machine":return this.#createMachineIdempotent(request.id,params);
   case"create_workspace":return this.#createWorkspaceIdempotent(request.id,params);
   case"invoke_action":return this.#invokeAction(request.id,params);
   default:return encodeProviderFailure(request.id,failure("unsupported_version",`${request.method} is not implemented by this provider`));
  }
 }
 async #snapshot(authorization:AllowedAuthorization):Promise<WireValue>{
  const startedAt=this.now();
  try{
   const effective=new Set(authorization.effectiveCapabilities);
   const scopes=authorization.scopeIds.flatMap(scopeId=>{const scope=this.#deps.driver.getScope(scopeId);return scope.outcome==="found"?[scope.resource]:[]});
   if(!this.#selectedScope||!scopes.some(scope=>scope.id===this.#selectedScope))this.#selectedScope=scopes[0]!.id;
   const machines=this.#deps.driver.listRuntimes(this.#selectedScope as ScopeId).items;
   let workspaceCreate:Record<string,WireValue>;
   if(effective.has("workspace.create")){
    workspaceCreate={owner:"provider",default_mode:"isolated",modes:["isolated","host"]};
   }else{
    workspaceCreate={owner:"session"};
   }
   const actions=this.#capabilities.includes(PROVIDER_ACTION_TARGETS_CLIENT_CAPABILITY)?Object.entries(INVOKE_ACTIONS).filter(([,capability])=>effective.has(capability)).map(([id])=>({id,label:id[0]!.toUpperCase()+id.slice(1),target:"selected_machine",destructive:id==="stop",fields:[]})):[];
   this.#revision++;
   const result={revision:this.#revision,scopes:scopes.map(scope=>({id:scope.id,display_name:scope.displayName,kind:scope.kind==="Personal"?"personal":"team",can_admin:effective.has("scope.admin")})),selected_scope_id:this.#selectedScope,machines:machines.map(runtime=>({id:runtime.id,display_name:runtime.displayName,status:status(runtime.phase,runtime.desiredState),connectable:effective.has("runtime.connect.cmux")&&runtime.phase==="Ready"&&runtime.desiredState==="Running",workspace_create:workspaceCreate})),capabilities:{create_machine:effective.has("runtime.create"),connect_external_machine:false},actions};
   this.#deps.metrics?.observe("omperator_provider_snapshot_duration_seconds",Math.max(0,(this.now()-startedAt)/1_000),{result:"success"});
   return result;
  }catch(error){
   this.#deps.metrics?.observe("omperator_provider_snapshot_duration_seconds",Math.max(0,(this.now()-startedAt)/1_000),{result:"error"});
   throw error;
  }
 }
 async #open(id:string,runtimeId:string):Promise<Uint8Array>{
  let found=this.#deps.driver.getRuntime(runtimeId);
  if(found.outcome!=="found")return encodeProviderFailure(id,failure("not_found","machine was not found"));
  let runtime=found.resource;
  if(runtime.desiredState==="Stopped")return encodeProviderFailure(id,failure("unavailable","stopped machine requires an explicit wake action"));
  if(runtime.desiredState==="Sleeping"){
   const wake=await this.#deps.driver.setRuntimeDesiredState(runtime.id,"Running",runtime.revision);
   if(wake.outcome!=="updated"){this.#deps.metrics?.increment("omperator_wake_total",{result:"error"});return encodeProviderFailure(id,failure("wake_retry","machine could not be woken",true))}
   runtime=wake.resource;
  }
  const deadline=this.now()+this.wakeTimeoutMs();
  for(;;){
   if(runtime.desiredState==="Running"&&runtime.phase==="Ready"){
    const route=this.#deps.driver.resolveRuntimeRoute(runtime.id,"cmux-v10",runtime.generation);
    if(route.outcome==="resolved"){
     const ttl=this.#deps.ticketTtlSeconds??30;
     const binding:TicketBinding={runtimeId:runtime.id,runtimeGeneration:route.generation,purpose:PROVIDER_STREAM_PURPOSE,audience:PROVIDER_STREAM_AUDIENCE,principalId:this.#identity.principalId,scopeId:runtime.scopeId,providerControlGeneration:this.#generation};
     let issued:{readonly ticket:string;readonly expiresAt:string};
     try{
      issued=await this.#deps.tickets.mintTicket({...binding,ttlSeconds:ttl});
      this.#deps.metrics?.increment("omperator_provider_ticket_total",{operation:"issue",result:"success"});
     }catch(error){
      this.#deps.metrics?.increment("omperator_provider_ticket_total",{operation:"issue",result:"error"});
      throw error;
     }
     const connectionId=`conn_${Buffer.from((this.#deps.randomBytes??randomBytes)(18)).toString("base64url")}`;
     const registered=await this.#deps.connections.register({...binding,connectionId,ticket:issued.ticket});
     if(registered.outcome!=="registered"){await this.#revokeTicket(issued.ticket);return encodeProviderFailure(id,failure("wake_retry","machine connection registration raced",true))}
     this.#issued.set(connectionId,{ticket:issued.ticket,binding});
     this.#revision++;
     this.#deps.metrics?.increment("omperator_wake_total",{result:"success"});
     return encodeProviderSuccess(id,{connection_id:connectionId,transport:{kind:"provider_stream",ticket:issued.ticket,expires_at:issued.expiresAt}});
    }
    if(route.outcome!=="notReady"){this.#deps.metrics?.increment("omperator_wake_total",{result:"error"});return encodeProviderFailure(id,failure("wake_failed",`machine route is ${route.outcome}`,false))}
   }
   if(this.now()>=deadline){this.#deps.metrics?.increment("omperator_wake_total",{result:"timeout"});return encodeProviderFailure(id,failure("wake_timeout",`machine wake timed out in phase ${runtime.phase}`,true))}
   await this.wait(Math.min(this.wakePollIntervalMs(),Math.max(1,deadline-this.now())));
   found=this.#deps.driver.getRuntime(runtimeId);
   if(found.outcome!=="found"){this.#deps.metrics?.increment("omperator_wake_total",{result:"error"});return encodeProviderFailure(id,failure("not_found","machine disappeared while waking"))}
   runtime=found.resource;
   if(runtime.desiredState==="Stopped"||runtime.phase==="Failed"||runtime.phase==="Degraded"){
    this.#deps.metrics?.increment("omperator_wake_total",{result:"error"});
    return encodeProviderFailure(id,failure("wake_failed",`machine wake failed in phase ${runtime.phase}`,runtime.phase==="Degraded"));
   }
  }
 }
 async #revokeTicket(ticket:string):Promise<void>{
  try{
   await this.#deps.tickets.revokeTicket(ticket);
   this.#deps.metrics?.increment("omperator_provider_ticket_total",{operation:"revoke",result:"success"});
  }catch(error){
   this.#deps.metrics?.increment("omperator_provider_ticket_total",{operation:"revoke",result:"error"});
   throw error;
  }
 }
 async #closeConnection(id:string,connectionId:string):Promise<Uint8Array>{const issued=this.#issued.get(connectionId);if(!issued||issued.binding.principalId!==this.#identity.principalId||issued.binding.providerControlGeneration!==this.#generation)return encodeProviderFailure(id,failure("not_found","connection was not found"));await this.#revokeTicket(issued.ticket);await this.#deps.connections.close(connectionId);this.#issued.delete(connectionId);this.#revision++;return encodeProviderSuccess(id,{revision:this.#revision})}
 async #invokeAction(id:string,p:Record<string,WireValue>):Promise<Uint8Array>{
  const actionId=stringField(p,"action_id"),runtimeId=typeof p.machine_id==="string"?p.machine_id:undefined,mutationId=stringField(p,"mutation_id");
  if(runtimeId===undefined)return encodeProviderFailure(id,failure("invalid_input","action requires a machine target"));
  const found=this.#deps.driver.getRuntime(runtimeId);
  if(found.outcome!=="found")return encodeProviderFailure(id,failure("not_found","machine was not found"));
  const desired=actionId==="wake"?"Running":actionId==="sleep"?"Sleeping":actionId==="stop"?"Stopped":undefined;
  if(desired===undefined)return encodeProviderFailure(id,failure("permission_denied","action target is not enabled"));
  const canonicalBody=canonicalWire(p);
  const key={principalId:this.#identity.principalId,scopeId:found.resource.scopeId,method:"POST",canonicalPath:`/runtimes/${runtimeId}/actions/${actionId}`,idempotencyKey:mutationId,canonicalBodyDigest:createHash("sha256").update(canonicalBody).digest("hex")};
  const reservation=await this.#deps.tickets.reserveIdempotency(key);
  if(reservation.outcome==="conflict")return encodeProviderFailure(id,failure("conflict","mutation id was reused with different input"));
  if(reservation.outcome==="pending")return encodeProviderFailure(id,failure("conflict","mutation is already pending",true));
  if(reservation.outcome==="replay"){
   const replay=reservation.result;
   if(!jsonRecord(replay))return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
   if(typeof replay.revision==="string")return encodeProviderSuccess(id,{revision:BigInt(replay.revision)});
   if(jsonRecord(replay.error)&&typeof replay.error.code==="string"&&typeof replay.error.message==="string"&&typeof replay.error.retryable==="boolean")return encodeProviderFailure(id,{code:replay.error.code,message:replay.error.message,retryable:replay.error.retryable});
   return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
  }
  const updated=await this.#deps.driver.setRuntimeDesiredState(runtimeId,desired,found.resource.revision);
  if(updated.outcome!=="updated"){
   if(updated.outcome==="fenceUncertain")return encodeProviderFailure(id,failure("unavailable","action outcome is fence-uncertain",true));
   const deterministicError=failure(updated.outcome==="notFound"?"not_found":"conflict","action could not be applied");
   const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result:{error:{code:deterministicError.code,message:deterministicError.message,retryable:deterministicError.retryable}}});
   if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
   return encodeProviderFailure(id,deterministicError);
  }
  this.#revision++;
  const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result:{revision:this.#revision.toString()}});
  if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
  return encodeProviderSuccess(id,{revision:this.#revision});
 }
 async #createMachineIdempotent(id:string,p:Record<string,WireValue>):Promise<Uint8Array>{
  const scopeId=stringField(p,"scope_id"),mutationId=stringField(p,"mutation_id"),key={principalId:this.#identity.principalId,scopeId,method:"POST",canonicalPath:`/scopes/${scopeId}/machines`,idempotencyKey:mutationId,canonicalBodyDigest:createHash("sha256").update(JSON.stringify({scopeId})).digest("hex")};
  const reservation=await this.#deps.tickets.reserveIdempotency(key);
  if(reservation.outcome==="conflict")return encodeProviderFailure(id,failure("conflict","mutation id was reused with different input"));
  if(reservation.outcome==="replay")return this.#machineCreationReplay(id,reservation.result);
  if(reservation.outcome==="pending"){
   const policy=await this.#deps.creationPolicy.runtime({scopeId,mutationId,identity:this.#identity});
   if(policy.id!==undefined){
    const existing=this.#deps.driver.getRuntime(policy.id);
    if(existing.outcome==="found"&&existing.resource.scopeId===scopeId){
     const result={machineId:existing.resource.id,revision:(this.#revision+1n).toString()};
     const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
     if(reconciled.outcome==="completed"){this.#revision++;return this.#machineCreationReplay(id,result)}
     if(reconciled.outcome==="alreadyCompleted")return this.#machineCreationReplay(id,reconciled.result);
    }
   }
   return encodeProviderFailure(id,failure("conflict","mutation is already pending",true));
  }
  const policy=await this.#deps.creationPolicy.runtime({scopeId,mutationId,identity:this.#identity});
  if(policy.id!==undefined){
   const existing=this.#deps.driver.getRuntime(policy.id);
   if(existing.outcome==="found"&&existing.resource.scopeId===scopeId){
    const result={machineId:existing.resource.id,revision:(this.#revision+1n).toString()};
    const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
    if(reconciled.outcome==="completed"){this.#revision++;return this.#machineCreationReplay(id,result)}
    if(reconciled.outcome==="alreadyCompleted")return this.#machineCreationReplay(id,reconciled.result);
    return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
   }
  }
  const created=await this.#deps.driver.createRuntime(policy);
  if(created.outcome!=="created"){
   if(created.outcome==="admissionDenied"){
    if(reservation.outcome==="new")await this.#deps.tickets.releaseIdempotency({...key,reservationToken:reservation.reservationToken});
    const retryAfter=created.retryAfterSeconds===undefined?"":`; retry after ${Math.max(1,Math.min(300,created.retryAfterSeconds))}s`;
    return encodeProviderFailure(id,failure(created.reason==="creation_rate_limit"?"provider_rate_limited":"resource_exhausted",`admission denied: ${created.reason}${retryAfter}`,true));
   }
   if(created.outcome==="invalidState"||created.outcome==="fenceUncertain"){
    if(reservation.outcome==="new")await this.#deps.tickets.releaseIdempotency({...key,reservationToken:reservation.reservationToken});
    return encodeProviderFailure(id,failure("unavailable","machine creation could not be confirmed",true));
   }
   const deterministic=failure(created.outcome==="alreadyIssued"?"conflict":"not_found","machine creation failed");
   const result={error:{code:deterministic.code,message:deterministic.message,retryable:deterministic.retryable}};
   const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result});
   if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound"){
    const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
    if(reconciled.outcome!=="completed"&&reconciled.outcome!=="alreadyCompleted")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
   }
   return encodeProviderFailure(id,deterministic);
  }
  this.#revision++;
  const result={machineId:created.resource.id,revision:this.#revision.toString()};
  const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result});
  if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound"){
   const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
   if(reconciled.outcome==="alreadyCompleted")return this.#machineCreationReplay(id,reconciled.result);
   if(reconciled.outcome!=="completed")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
  }
  return encodeProviderSuccess(id,{machine_id:created.resource.id,revision:this.#revision});
 }
 async #createWorkspaceIdempotent(id:string,p:Record<string,WireValue>):Promise<Uint8Array>{
  const machineId=stringField(p,"machine_id"),mode=stringField(p,"mode")as"isolated"|"host",mutationId=stringField(p,"mutation_id"),runtime=this.#deps.driver.getRuntime(machineId);
  if(runtime.outcome!=="found")return encodeProviderFailure(id,failure("not_found","machine was not found"));
  const scopeId=runtime.resource.scopeId,key={principalId:this.#identity.principalId,scopeId,method:"POST",canonicalPath:`/machines/${machineId}/workspaces`,idempotencyKey:mutationId,canonicalBodyDigest:createHash("sha256").update(JSON.stringify({machineId,mode})).digest("hex")};
  const reservation=await this.#deps.tickets.reserveIdempotency(key);
  if(reservation.outcome==="conflict")return encodeProviderFailure(id,failure("conflict","mutation id was reused with different input"));
  if(reservation.outcome==="replay")return this.#workspaceCreationReplay(id,reservation.result);
  if(reservation.outcome==="pending"){
   const policy=await this.#deps.creationPolicy.workspace({machineId,mode,mutationId,identity:this.#identity});
   if(policy.id!==undefined){
    const existing=this.#deps.driver.getWorkspace(policy.id);
    if(existing.outcome==="found"&&existing.resource.scopeId===scopeId){
     const result={revision:(this.#revision+1n).toString()};
     const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
     if(reconciled.outcome==="completed"){this.#revision++;return this.#workspaceCreationReplay(id,result)}
     if(reconciled.outcome==="alreadyCompleted")return this.#workspaceCreationReplay(id,reconciled.result);
    }
   }
   return encodeProviderFailure(id,failure("conflict","mutation is already pending",true));
  }
  const policy=await this.#deps.creationPolicy.workspace({machineId,mode,mutationId,identity:this.#identity});
  if(policy.id!==undefined){
   const existing=this.#deps.driver.getWorkspace(policy.id);
   if(existing.outcome==="found"&&existing.resource.scopeId===scopeId){
    const result={revision:(this.#revision+1n).toString()};
    const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
    if(reconciled.outcome==="completed"){this.#revision++;return this.#workspaceCreationReplay(id,result)}
    if(reconciled.outcome==="alreadyCompleted")return this.#workspaceCreationReplay(id,reconciled.result);
    return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
   }
  }
  const created=await this.#deps.driver.createWorkspace(policy);
  if(created.outcome!=="created"){
   if(created.outcome==="admissionDenied"){
    if(reservation.outcome==="new")await this.#deps.tickets.releaseIdempotency({...key,reservationToken:reservation.reservationToken});
    const retryAfter=created.retryAfterSeconds===undefined?"":`; retry after ${Math.max(1,Math.min(300,created.retryAfterSeconds))}s`;
    return encodeProviderFailure(id,failure(created.reason==="creation_rate_limit"?"provider_rate_limited":"resource_exhausted",`admission denied: ${created.reason}${retryAfter}`,true));
   }
   if(created.outcome==="invalidState"||created.outcome==="fenceUncertain"){
    if(reservation.outcome==="new")await this.#deps.tickets.releaseIdempotency({...key,reservationToken:reservation.reservationToken});
    return encodeProviderFailure(id,failure("unavailable","workspace creation could not be confirmed",true));
   }
   const deterministic=failure(created.outcome==="alreadyIssued"?"conflict":"not_found","workspace creation failed");
   const result={error:{code:deterministic.code,message:deterministic.message,retryable:deterministic.retryable}};
   const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result});
   if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound"){
    const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
    if(reconciled.outcome!=="completed"&&reconciled.outcome!=="alreadyCompleted")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
   }
   return encodeProviderFailure(id,deterministic);
  }
  this.#revision++;
  const result={revision:this.#revision.toString()};
  const completed=await this.#deps.tickets.completeIdempotency({...key,reservationToken:reservation.reservationToken,result});
  if(completed.outcome==="reservationMismatch"||completed.outcome==="notFound"){
   const reconciled=await this.#deps.tickets.reconcileIdempotency({...key,result});
   if(reconciled.outcome==="alreadyCompleted")return this.#workspaceCreationReplay(id,reconciled.result);
   if(reconciled.outcome!=="completed")return encodeProviderFailure(id,failure("unavailable","mutation result could not be committed",true));
  }
  return encodeProviderSuccess(id,{revision:this.#revision});
 }
 #machineCreationReplay(id:string,replay:WireValue):Uint8Array{
  if(!jsonRecord(replay))return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
  if(typeof replay.machineId==="string"&&typeof replay.revision==="string")return encodeProviderSuccess(id,{machine_id:replay.machineId,revision:BigInt(replay.revision)});
  if(jsonRecord(replay.error)&&typeof replay.error.code==="string"&&typeof replay.error.message==="string"&&typeof replay.error.retryable==="boolean")return encodeProviderFailure(id,{code:replay.error.code,message:replay.error.message,retryable:replay.error.retryable});
  return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
 }
 #workspaceCreationReplay(id:string,replay:WireValue):Uint8Array{
  if(!jsonRecord(replay))return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
  if(typeof replay.revision==="string")return encodeProviderSuccess(id,{revision:BigInt(replay.revision)});
  if(jsonRecord(replay.error)&&typeof replay.error.code==="string"&&typeof replay.error.message==="string"&&typeof replay.error.retryable==="boolean")return encodeProviderFailure(id,{code:replay.error.code,message:replay.error.message,retryable:replay.error.retryable});
  return encodeProviderFailure(id,failure("internal","stored mutation result is corrupt"));
 }
 async #revokeBindings(bindings:readonly TicketBinding[],cause:"controlDisconnect"|"providerControlGenerationReplacement",generation:string):Promise<void>{
  const seen=new Set<string>();
  for(const binding of bindings){
   const key=`${binding.scopeId}\u0000${binding.runtimeId}`;
   if(seen.has(key))continue;
   seen.add(key);
   await this.#deps.tickets.revokeTickets({cause,scopeId:binding.scopeId,runtimeId:binding.runtimeId,providerControlGeneration:generation});
  }
 }
}
export const createProviderControlSession=(dependencies:ProviderControlDependencies,identity:ProviderIngressIdentity)=>new ProviderControlSession(dependencies,identity);
