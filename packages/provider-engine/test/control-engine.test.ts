import { expect,test } from "bun:test";
import { createHash } from "node:crypto";
import type { PortableControlStore } from "@t4-code/portable-control-store";
import type { ResourceDriver } from "@t4-code/portable-driver";
import { createProviderControlSession } from "../src/control-engine.js";
import { MemoryProviderConnectionRegistry } from "../src/connection-registry.js";
import { decodeProviderResponseFrame,encodeProviderRequest,type ProviderMethod,type WireValue } from "../src/machine-provider-v1.js";
const request=(id:string,method:ProviderMethod,params:Record<string,WireValue>)=>encodeProviderRequest({protocol:"cmux.machine-provider",version:1,id,method,params});
const response=(bytes:Uint8Array)=>JSON.parse(new TextDecoder().decode(bytes));
const allowed=(capabilities:readonly string[]=["runtime.read","runtime.connect.cmux","runtime.create","workspace.create","scope.admin","runtime.delete","destructive.confirmation"] )=>({outcome:"allowed" as const,scopeIds:["scope"],effectiveCapabilities:["scope.read",...capabilities],policyRevision:"policy-1"});
function dependencies(){
 let revocations=0;
 const runtime={id:"runtime",scopeId:"scope",displayName:"Runtime",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",phase:"Ready",generation:"runtime-generation",revision:"revision",capabilities:[],conditions:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"};
 const driver={getRuntime:()=>({outcome:"found",resource:runtime}),getWorkspace:()=>({outcome:"notFound"}),setRuntimeDesiredState:async()=>({outcome:"updated",resource:runtime}),resolveRuntimeRoute:()=>({outcome:"resolved",route:{kind:"cmux-v10",reference:"opaque"},generation:runtime.generation}),listScopes:()=>({items:[{id:"scope",displayName:"Scope",kind:"Personal",revision:"revision"},{id:"other",displayName:"Other",kind:"Team",revision:"other-revision"}]}),listRuntimes:()=>({items:[runtime],highWaterCursor:"cursor"}),getScope:()=>({outcome:"found",resource:{id:"scope",displayName:"Scope",kind:"Personal",revision:"revision"}})} as unknown as ResourceDriver;
 const tickets={mintTicket:()=>({ticket:"abcdefghijklmnopqrstuvwxyzABCDEFG_123456",expiresAt:"2026-01-01T00:00:30.000Z"}),revokeTicket:()=>{revocations++;return true},revokeTickets:()=>{revocations++;return 1},reserveIdempotency:()=>({outcome:"new",reservationToken:"reservation"}),completeIdempotency:()=>({outcome:"completed"})} as unknown as PortableControlStore;
 return{driver,tickets,get revocations(){return revocations}};
}
test("canonical authorization, scoped projection, and mirror rejection are fail closed",async()=>{const deps=dependencies(),requests:{method:string;actions:readonly string[]}[]=[];const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async value=>{requests.push({method:value.method,actions:value.canonicalActions});return allowed()},creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("1","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const snapshot=response((await session.receive(request("2","snapshot",{})))[0]!);expect(snapshot.result.scopes.map((scope:{id:string})=>scope.id)).toEqual(["scope"]);expect(snapshot.result.scopes[0].can_admin).toBe(true);expect(snapshot.result.capabilities.create_machine).toBe(true);expect(snapshot.result.machines[0].connectable).toBe(true);const mirror=response((await session.receive(request("3","open_machine",{machine_id:"runtime",workspace_mirror_authority:true})))[0]!);expect(mirror.error.code).toBe("invalid_input");expect(requests).toEqual([{method:"hello",actions:["scope.read"]},{method:"snapshot",actions:["runtime.read"]},{method:"open_machine",actions:["runtime.connect.cmux"]}])});
test("invoke target resolves to its exact canonical action before mutation",async()=>{const deps=dependencies();let actions:readonly string[]=[];const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async value=>{actions=value.canonicalActions;return allowed(["runtime.stop"])},creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("1","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const result=response((await session.receive(request("2","invoke_action",{action_id:"stop",machine_id:"runtime",mutation_id:"mutation",values:{}})))[0]!);expect(result.result.revision).toBeDefined();expect(actions).toEqual(["runtime.stop"]);const denied=response((await session.receive(request("3","invoke_action",{action_id:"unknown",machine_id:"runtime",mutation_id:"other",values:{}})))[0]!);expect(denied.error.code).toBe("permission_denied")});
test("generation replacement and disconnect revoke generation-bound tickets and streams",async()=>{const deps=dependencies(),registry=new MemoryProviderConnectionRegistry(),makeSession=(bearer:string)=>{const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:registry,authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}},randomBytes:()=>new Uint8Array(18)},{principalId:"principal",transport:"internal",authority:{}});return{session,bearer}};const first=makeSession("first");await first.session.receive(request("1","hello",{token:first.bearer,client:{name:"client",version:"1",supported_versions:[1]}}));await first.session.receive(request("2","open_machine",{machine_id:"runtime"}));const second=makeSession("second");await second.session.receive(request("3","hello",{token:second.bearer,client:{name:"client",version:"1",supported_versions:[1]}}));expect(second.session.providerControlGeneration).toBe(createHash("sha256").update("second").digest("hex"));expect(deps.revocations).toBe(1);await second.session.close()});
test("destructive methods require their exact action and destructive confirmation",async()=>{const deps=dependencies(),seen:(readonly string[])[]=[];const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async value=>{seen.push(value.canonicalActions);return allowed()},creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("1","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));await session.receive(request("2","delete_machine",{scope_id:"scope",machine_id:"runtime",expected_version:1n,mutation_id:"mutation"}));expect(seen.at(-1)).toEqual(["runtime.delete","destructive.confirmation"])});
test("invoke action mutation id replays without applying the transition twice",async()=>{const deps=dependencies();let mutations=0,reserved=false;Object.assign(deps.driver,{setRuntimeDesiredState:async()=>{mutations++;const current=deps.driver.getRuntime("runtime");if(current.outcome!=="found")throw new Error("runtime fixture missing");return{outcome:"updated",resource:current.resource}}});Object.assign(deps.tickets,{reserveIdempotency:()=>reserved?{outcome:"replay",result:{revision:"1"}}:(reserved=true,{outcome:"new",reservationToken:"reservation"}),completeIdempotency:()=>({outcome:"completed"})});const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(["runtime.stop"]),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("1","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const invoke={action_id:"stop",machine_id:"runtime",mutation_id:"same",values:{}}as const;const first=response((await session.receive(request("2","invoke_action",invoke)))[0]!),second=response((await session.receive(request("3","invoke_action",invoke)))[0]!);expect(first.result).toEqual(second.result);expect(mutations).toBe(1)});
test("duplicate live bearer cannot steal generation ownership",async()=>{const deps=dependencies(),registry=new MemoryProviderConnectionRegistry(),create=()=>createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:registry,authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}}),hello=request("hello","hello",{token:"same-bearer",client:{name:"client",version:"1",supported_versions:[1]}}),first=create(),second=create();expect(response((await first.receive(hello))[0]!).result).toBeDefined();expect(response((await second.receive(hello))[0]!).error.code).toBe("conflict");expect(response((await first.receive(request("snapshot","snapshot",{})))[0]!).result).toBeDefined()});
test("invoke action idempotency fingerprint is independent of values map order",async()=>{const deps=dependencies();let digest:string|undefined,mutations=0;Object.assign(deps.driver,{setRuntimeDesiredState:async()=>{mutations++;const current=deps.driver.getRuntime("runtime");if(current.outcome!=="found")throw new Error("runtime fixture missing");return{outcome:"updated",resource:current.resource}}});Object.assign(deps.tickets,{reserveIdempotency:(key:{canonicalBodyDigest:string})=>{if(digest===undefined){digest=key.canonicalBodyDigest;return{outcome:"new",reservationToken:"reservation"}}return digest===key.canonicalBodyDigest?{outcome:"replay",result:{revision:"1"}}:{outcome:"conflict"}},completeIdempotency:()=>({outcome:"completed"})});const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(["runtime.stop"]),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const first=response((await session.receive(request("first","invoke_action",{action_id:"stop",machine_id:"runtime",mutation_id:"same",values:{alpha:"one",beta:2n}})))[0]!),second=response((await session.receive(request("second","invoke_action",{action_id:"stop",machine_id:"runtime",mutation_id:"same",values:{beta:2n,alpha:"one"}})))[0]!);expect(first.result).toEqual(second.result);expect(mutations).toBe(1)});
test("invoke action rejects workspace and mixed targets after authorizing the machine authoritative scope",async()=>{const deps=dependencies(),seen:{scopeId?:string;runtimeId?:string;workspaceId?:string}[]=[];Object.assign(deps.driver,{getWorkspace:()=>({outcome:"found",resource:{id:"workspace-other",scopeId:"other-scope"}})});let mutations=0;Object.assign(deps.driver,{setRuntimeDesiredState:async()=>{mutations++;throw new Error("must not mutate")}});const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async value=>{seen.push(value.selectors);return allowed(["runtime.stop"])},creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const mixed=response((await session.receive(request("mixed","invoke_action",{action_id:"stop",machine_id:"runtime",workspace_id:"workspace-other",mutation_id:"mixed"})))[0]!),workspace=response((await session.receive(request("workspace","invoke_action",{action_id:"stop",workspace_id:"workspace-other",mutation_id:"workspace"})))[0]!);expect(mixed.error.code).toBe("invalid_input");expect(workspace.error.code).toBe("invalid_input");expect(seen.at(-2)).toMatchObject({scopeId:"scope",runtimeId:"runtime",workspaceId:"workspace-other"});expect(seen.at(-1)).toMatchObject({workspaceId:"workspace-other"});expect(seen.at(-1)?.scopeId).toBeUndefined();expect(mutations).toBe(0)});
test("deterministic invoke failure is completed and replayed instead of left pending",async()=>{const deps=dependencies();let stored:unknown,mutations=0;Object.assign(deps.driver,{setRuntimeDesiredState:async()=>{mutations++;return{outcome:"revisionMismatch",currentRevision:"new-revision"}}});Object.assign(deps.tickets,{reserveIdempotency:()=>stored===undefined?{outcome:"new",reservationToken:"reservation"}:{outcome:"replay",result:stored},completeIdempotency:(request:{result:unknown})=>{stored=request.result;return{outcome:"completed"}}});const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(["runtime.stop"]),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const invoke={action_id:"stop",machine_id:"runtime",mutation_id:"same"}as const,first=response((await session.receive(request("first","invoke_action",invoke)))[0]!),second=response((await session.receive(request("second","invoke_action",invoke)))[0]!);expect(first.error).toEqual(second.error);expect(first.error.code).toBe("conflict");expect(mutations).toBe(1)});
test("close machine never forwards an unissued client connection id to the registry",async()=>{const deps=dependencies(),registry=new MemoryProviderConnectionRegistry();let closes=0;Object.assign(registry,{close:async()=>{closes++;return{outcome:"closed"}}});const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:registry,authorize:async()=>allowed(["runtime.stop"]),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));const denied=response((await session.receive(request("close","close_machine",{connection_id:"connection-owned-by-another-session"})))[0]!);expect(denied.error.code).toBe("not_found");expect(closes).toBe(0)});
test("maps portable scope kinds to exact machine-provider wire enums",async()=>{
 const deps=dependencies();
 const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});
 await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));
 const snapshot=response((await session.receive(request("snapshot","snapshot",{})))[0]!);
 expect(snapshot.result.scopes[0].kind).toBe("personal");
});

test("machine creation failures are completed and replayed instead of stranding pending idempotency",async()=>{
 const deps=dependencies();let stored:WireValue|undefined,creates=0;
 Object.assign(deps.driver,{getRuntime:(id:string)=>id==="created-runtime"?{outcome:"notFound"}:({outcome:"found",resource:{id:"runtime",scopeId:"scope",displayName:"Runtime",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",phase:"Ready",generation:"runtime-generation",revision:"revision",capabilities:[],conditions:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"}}),createRuntime:async()=>{creates++;return{outcome:"notFound",resourceKind:"scope"}}});
 Object.assign(deps.tickets,{
  reserveIdempotency:()=>stored===undefined?{outcome:"new",reservationToken:"reservation"}:{outcome:"replay",result:stored},
  completeIdempotency:(value:{result:WireValue})=>{stored=value.result;return{outcome:"completed"}},
  reconcileIdempotency:(value:{result:WireValue})=>{stored=value.result;return{outcome:"completed"}},
 });
 const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),creationPolicy:{runtime:async()=>({id:"created-runtime",scopeId:"scope",displayName:"Created",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",browserPolicy:"Disabled"}),workspace:async()=>{throw new Error("not reached")}}},{principalId:"principal",transport:"internal",authority:{}});
 await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));
 const first=response((await session.receive(request("create-1","create_machine",{scope_id:"scope",mutation_id:"mutation-key-0001"})))[0]!);
 const replay=response((await session.receive(request("create-2","create_machine",{scope_id:"scope",mutation_id:"mutation-key-0001"})))[0]!);
 expect(first.error.code).toBe("not_found");expect(replay.error).toEqual(first.error);expect(creates).toBe(1);
});

test("indeterminate machine creation releases its reservation for a safe retry",async()=>{
 const deps=dependencies();let reserved=false,releases=0,creates=0;
 const created={id:"created-runtime",scopeId:"scope",displayName:"Created",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",phase:"Ready",generation:"runtime-generation-2",revision:"revision-2",capabilities:[],conditions:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"};
 Object.assign(deps.driver,{getRuntime:()=>({outcome:"notFound"}),createRuntime:async()=>++creates===1?{outcome:"fenceUncertain",resource:created}:{outcome:"created",resource:created}});
 Object.assign(deps.tickets,{
  reserveIdempotency:()=>reserved?{outcome:"pending"}:(reserved=true,{outcome:"new",reservationToken:"reservation"}),
  releaseIdempotency:()=>{reserved=false;releases++;return{outcome:"released"}},
  completeIdempotency:()=>({outcome:"completed"}),
 });
 const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),creationPolicy:{runtime:async()=>({id:"created-runtime",scopeId:"scope",displayName:"Created",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",browserPolicy:"Disabled"}),workspace:async()=>{throw new Error("not reached")}}},{principalId:"principal",transport:"internal",authority:{}});
 await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));
 const first=response((await session.receive(request("create-1","create_machine",{scope_id:"scope",mutation_id:"mutation-key-uncertain"})))[0]!);
 const retried=response((await session.receive(request("create-2","create_machine",{scope_id:"scope",mutation_id:"mutation-key-uncertain"})))[0]!);
 expect(first.error).toMatchObject({code:"unavailable",retryable:true});expect(retried.result.machine_id).toBe("created-runtime");expect(releases).toBe(1);expect(creates).toBe(2);
});

test("quota denial is typed, bounded, retryable, and releases provider idempotency",async()=>{
 const deps=dependencies();let releases=0;
 Object.assign(deps.driver,{getRuntime:()=>({outcome:"notFound"}),createRuntime:async()=>({outcome:"admissionDenied",reason:"creation_rate_limit",retryAfterSeconds:999})});
 Object.assign(deps.tickets,{reserveIdempotency:()=>({outcome:"new",reservationToken:"reservation"}),releaseIdempotency:()=>{releases++;return{outcome:"released"}}});
 const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),creationPolicy:{runtime:async()=>({id:"created-runtime",scopeId:"scope",displayName:"Created",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Running",browserPolicy:"Disabled"}),workspace:async()=>{throw new Error("not reached")}}},{principalId:"principal",transport:"internal",authority:{}});
 await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));
 const denied=response((await session.receive(request("create","create_machine",{scope_id:"scope",mutation_id:"mutation-key-rate"})))[0]!);
 expect(denied.error).toEqual({code:"provider_rate_limited",message:"admission denied: creation_rate_limit; retry after 300s",retryable:true});
 expect(releases).toBe(1);
});

test("pending workspace creation reconciles an exact deterministic resource after completion publication loss",async()=>{
 const deps=dependencies();let creates=0,reconciliations=0;
 Object.assign(deps.driver,{getWorkspace:(id:string)=>id==="created-workspace"?{outcome:"found",resource:{id,scopeId:"scope"}}:{outcome:"notFound"},createWorkspace:()=>{creates++;throw new Error("must reconcile without creating")}});
 Object.assign(deps.tickets,{reserveIdempotency:()=>({outcome:"pending"}),reconcileIdempotency:()=>{reconciliations++;return{outcome:"completed"}}});
 const session=createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error("not reached")},workspace:async()=>({id:"created-workspace",scopeId:"scope",displayName:"Created",capacityBytes:1_048_576,retention:"Delete"})}},{principalId:"principal",transport:"internal",authority:{}});
 await session.receive(request("hello","hello",{token:"bearer",client:{name:"client",version:"1",supported_versions:[1]}}));
 const result=response((await session.receive(request("workspace","create_workspace",{machine_id:"runtime",mode:"isolated",mutation_id:"mutation-key-0002"})))[0]!);
 expect(result.result.revision).toBeDefined();expect(reconciliations).toBe(1);expect(creates).toBe(0);
});

test("open_machine bounds sleeping wake and reports retryable phase timeout",async()=>{
 const make=async(readyAfter:number|undefined)=>{
  const deps=dependencies();let now=0,polls=0;
  const wakeResults:string[]=[],ticketResults:string[]=[];
  let runtime={id:"runtime",scopeId:"scope",displayName:"Runtime",workspaceId:"workspace",hostProfileId:"profile",desiredState:"Sleeping",phase:"Sleeping",generation:"old-generation",revision:"revision",capabilities:[],conditions:[],createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"};
  Object.assign(deps.driver,{
   getRuntime:()=>({outcome:"found",resource:runtime}),
   setRuntimeDesiredState:async()=>{runtime={...runtime,desiredState:"Running",phase:"Starting",revision:"revision-2"};return{outcome:"updated",resource:runtime}},
   resolveRuntimeRoute:(_id:string,_purpose:string,generation:string)=>generation==="new-generation"?{outcome:"resolved",route:{kind:"cmux-v10",reference:"opaque"},generation}:{outcome:"notReady"},
  });
  const session=createProviderControlSession({
   providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,
   connections:new MemoryProviderConnectionRegistry(),authorize:async()=>allowed(),
   creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}},
   metrics:{increment:(name,labels)=>{if(name==="omperator_wake_total")wakeResults.push(labels.result);if(name==="omperator_provider_ticket_total"&&"operation" in labels)ticketResults.push(`${labels.operation}:${labels.result}`)},observe:()=>undefined},
   randomBytes:()=>new Uint8Array(18),wakeTimeoutMs:100,wakePollIntervalMs:25,now:()=>now,
   sleep:async milliseconds=>{now+=milliseconds;polls++;if(readyAfter!==undefined&&polls>=readyAfter)runtime={...runtime,phase:"Ready",generation:"new-generation",revision:"revision-3"}},
  },{principalId:"principal",transport:"internal",authority:{}});
  await session.receive(request("hello","hello",{token:`bearer-${readyAfter??"timeout"}`,client:{name:"client",version:"1",supported_versions:[1]}}));
  return{session,clock:()=>now,wakeResults,ticketResults};
 };
 const waking=await make(2);
 const openedFrame=(await waking.session.receive(request("open","open_machine",{machine_id:"runtime",workspace_mirror_authority:false})))[0]!;
 const opened=response(openedFrame);
 expect(()=>decodeProviderResponseFrame(openedFrame.subarray(0,-1),"open_machine")).not.toThrow();
 expect(opened.error).toBeUndefined();expect(opened.result.connection_id).toBeDefined();expect(waking.clock()).toBe(50);
 expect(opened.result.transport).toMatchObject({kind:"provider_stream",ticket:"abcdefghijklmnopqrstuvwxyzABCDEFG_123456",expires_at:"2026-01-01T00:00:30.000Z"});expect(opened.result.revision).toBeUndefined();
 expect(waking.wakeResults).toEqual(["success"]);
 expect(waking.ticketResults).toEqual(["issue:success"]);
 const timingOut=await make(undefined);
 const timeout=response((await timingOut.session.receive(request("timeout","open_machine",{machine_id:"runtime",workspace_mirror_authority:false})))[0]!);
 expect(timeout.error).toEqual({code:"wake_timeout",message:"machine wake timed out in phase Starting",retryable:true});
 expect(timingOut.clock()).toBe(100);
 expect(timingOut.wakeResults).toEqual(["timeout"]);
});

test("replacement cleanup failure releases the newly installed generation", async () => {
 const deps=dependencies(),registry=new MemoryProviderConnectionRegistry();
 const oldGeneration="old-generation";
 const binding={principalId:"principal",scopeId:"scope",audience:"cmux-machine-provider",runtimeId:"runtime",runtimeGeneration:"runtime-generation",providerControlGeneration:oldGeneration,purpose:"runtime.connect.cmux"};
 await registry.installControlGeneration({principalId:"principal",generation:oldGeneration});
 await registry.register({...binding,connectionId:"old-connection",ticket:"z".repeat(32)});
 Object.assign(deps.tickets,{revokeTickets:()=>{throw new Error("revocation unavailable")}});
 const create=()=>createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:registry,authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});
 const hello=request("hello","hello",{token:"replacement-bearer",client:{name:"client",version:"1",supported_versions:[1]}});
 await expect(create().receive(hello)).rejects.toThrow("revocation unavailable");
 Object.assign(deps.tickets,{revokeTickets:()=>0});
 expect(response((await create().receive(hello))[0]!).result).toBeDefined();
});

test("ambiguous generation CAS retries with the same owner without stealing duplicate bearer authority", async () => {
 const deps=dependencies(),registry=new MemoryProviderConnectionRegistry(),install=registry.installControlGeneration.bind(registry);
 let ambiguous=true;
 Object.assign(registry,{installControlGeneration:async(request:{principalId:string;generation:string;ownerId?:string})=>{const result=await install(request);if(ambiguous){ambiguous=false;throw new Error("ambiguous CAS result")}return result}});
 const create=()=>createProviderControlSession({providerId:"provider",providerName:"Provider",driver:deps.driver,tickets:deps.tickets,connections:registry,authorize:async()=>allowed(),creationPolicy:{runtime:async()=>{throw new Error()},workspace:async()=>{throw new Error()}}},{principalId:"principal",transport:"internal",authority:{}});
 const hello=request("hello","hello",{token:"ambiguous-bearer",client:{name:"client",version:"1",supported_versions:[1]}});
 const first=create();
 expect(response((await first.receive(hello))[0]!).result).toBeDefined();
 expect(response((await create().receive(hello))[0]!).error.code).toBe("conflict");
 await first.close();
});
