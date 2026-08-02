import { createHash, timingSafeEqual } from "node:crypto";
import type { ProviderControlLedger, TicketBinding, TicketConsumeOutcome } from "@t4-code/portable-control-store";
import type { ResourceDriver } from "@t4-code/portable-driver";
import { decodeTransportHandshakeFrame, encodeTransportHandshakeResult, MAX_CONTROL_FRAME_BYTES, MAX_CMUX_FRAME_BYTES } from "./machine-provider-v1.js";
import type { CmuxRouteOpener, DuplexByteStream } from "./cmux-route-opener.js";
import type { ProviderConnectionRegistry } from "./connection-registry.js";

export const PROVIDER_STREAM_AUDIENCE = "cmux-machine-provider";
export const PROVIDER_STREAM_PURPOSE = "runtime.connect.cmux";
export interface ProviderIngressIdentity { readonly principalId: string; readonly transport: "direct"|"ssh"|"internal"; readonly authority: unknown }
export interface ProviderAuthorizationRequest { readonly identity: ProviderIngressIdentity; readonly method: string; readonly canonicalActions: readonly string[]; readonly selectors: { readonly scopeId?: string; readonly runtimeId?: string; readonly workspaceId?: string; readonly connectionId?: string; readonly actionId?: string }; readonly providerControlGeneration: string }
export type ProviderAuthorizationOutcome={readonly outcome:"allowed";readonly scopeIds:readonly string[];readonly effectiveCapabilities:readonly string[];readonly policyRevision:string}|{readonly outcome:"denied"|"notFound"|"unavailable"};
export type ProviderStreamOutcome={readonly outcome:"relayed"|"clientClosed"|"runtimeClosed"|"revoked"|"transportError"}|{readonly outcome:"rejected";readonly reason:string};
export interface ProviderStreamOptions { readonly transport: DuplexByteStream; readonly identity: ProviderIngressIdentity; readonly tickets: ProviderControlLedger; readonly driver: ResourceDriver; readonly authorize:(request:ProviderAuthorizationRequest)=>Promise<ProviderAuthorizationOutcome>; readonly routeOpener:CmuxRouteOpener; readonly connections:ProviderConnectionRegistry; readonly signal?:AbortSignal }

function generation(token:string):string{return createHash("sha256").update(token).digest("hex")}
function constantEqual(left:string,right:string):boolean{const valid=/^[a-f0-9]{64}$/u.test(right),a=Buffer.from(left,"hex"),b=valid?Buffer.from(right,"hex"):Buffer.alloc(32);return timingSafeEqual(a,b)&&valid}
async function firstLine(source:AsyncIterator<Uint8Array>):Promise<{frame:Uint8Array;remainder:Uint8Array}>{const parts:Uint8Array[]=[];let total=0;for(;;){const next=await source.next();if(next.done)throw new Error("transport closed before handshake");const chunk=next.value,index=chunk.indexOf(10);if(index<0){total+=chunk.byteLength;if(total>MAX_CONTROL_FRAME_BYTES)throw new Error("handshake too large");parts.push(chunk);continue}total+=index;if(total>MAX_CONTROL_FRAME_BYTES)throw new Error("handshake too large");parts.push(chunk.subarray(0,index));const frame=new Uint8Array(total);let offset=0;for(const part of parts){frame.set(part,offset);offset+=part.byteLength}return{frame,remainder:chunk.subarray(index+1)}}}
class LineBound{#bytes=0;accept(chunk:Uint8Array){for(const byte of chunk){if(byte===10)this.#bytes=0;else if(++this.#bytes>MAX_CMUX_FRAME_BYTES)throw new Error("cmux frame too large")}}}
async function reject(transport:DuplexByteStream,reason:string):Promise<ProviderStreamOutcome>{try{await transport.write(encodeTransportHandshakeResult(false));await transport.end()}catch{}return{outcome:"rejected",reason}}

export async function runProviderStream(options:ProviderStreamOptions):Promise<ProviderStreamOutcome>{
 const iterator=options.transport.readable[Symbol.asyncIterator](),combined=new AbortController(),cancelled=Symbol("cancelled");
 const cancellation=Promise.withResolvers<typeof cancelled>();
 const abortFromOption=()=>combined.abort(options.signal?.reason);
 const resolveAdmissionCancellation=()=>{
  cancellation.resolve(cancelled);
  void iterator.return?.();
  void options.transport.close(combined.signal.reason);
 };
 options.signal?.addEventListener("abort",abortFromOption,{once:true});
 combined.signal.addEventListener("abort",resolveAdmissionCancellation,{once:true});
 if(options.signal?.aborted)abortFromOption();
 let handshake:{token:string;ticket:string},remainder:Uint8Array,active:Awaited<ReturnType<ProviderConnectionRegistry["activate"]>>|undefined,binding:TicketBinding,controlGeneration:string;
 try{
  const first=await Promise.race([firstLine(iterator),cancellation.promise]);
  if(first===cancelled)return{outcome:"revoked"};
  try{handshake=decodeTransportHandshakeFrame(first.frame);remainder=first.remainder}catch{return reject(options.transport,"invalidHandshake")}
  if(combined.signal.aborted)return{outcome:"revoked"};
  controlGeneration=generation(handshake.token);
  let consumed:TicketConsumeOutcome;
  try{consumed=await options.tickets.consumeTicketForTransport({ticket:handshake.ticket,principalId:options.identity.principalId,audience:PROVIDER_STREAM_AUDIENCE,providerControlGeneration:controlGeneration,purpose:PROVIDER_STREAM_PURPOSE})}catch{return reject(options.transport,"ticketRejected")}
  if(consumed.outcome!=="consumed")return reject(options.transport,"ticketRejected");
  binding=consumed.binding;
  if(!constantEqual(controlGeneration,binding.providerControlGeneration))return reject(options.transport,"generationMismatch");
  if(combined.signal.aborted)return{outcome:"revoked"};
  let authorization:ProviderAuthorizationOutcome;
  try{
   const authorized=await Promise.race([options.authorize({identity:options.identity,method:"provider_stream",canonicalActions:[PROVIDER_STREAM_PURPOSE],selectors:{scopeId:binding.scopeId,runtimeId:binding.runtimeId},providerControlGeneration:controlGeneration}),cancellation.promise]);
   if(authorized===cancelled)return{outcome:"revoked"};
   authorization=authorized;
  }catch{return reject(options.transport,"authorizationUnavailable")}
  if(authorization.outcome!=="allowed")return reject(options.transport,authorization.outcome);
  if(!authorization.scopeIds.includes(binding.scopeId)||!authorization.effectiveCapabilities.includes(PROVIDER_STREAM_PURPOSE))return reject(options.transport,"denied");
  if(combined.signal.aborted)return{outcome:"revoked"};
  const route=options.driver.resolveRuntimeRoute(binding.runtimeId,"cmux-v10",binding.runtimeGeneration);
  if(route.outcome!=="resolved")return reject(options.transport,route.outcome);
  const activation=options.connections.activate({...binding,ticket:handshake.ticket});
  const activated=await Promise.race([activation,cancellation.promise]);
  if(activated===cancelled){
   void activation.then(outcome=>outcome.outcome==="active"?outcome.connection.release().catch(()=>undefined):undefined).catch(()=>undefined);
   return{outcome:"revoked"};
  }
  active=activated;
  if(active.outcome!=="active")return reject(options.transport,"connectionClosed");
  const abortFromConnection=()=>combined.abort(active?.outcome==="active"?active.connection.signal.reason:undefined);
  active.connection.signal.addEventListener("abort",abortFromConnection,{once:true});
  if(active.connection.signal.aborted)abortFromConnection();
  const revocation=Promise.withResolvers<"revoked">(),resolveRevoked=()=>revocation.resolve("revoked");
  combined.signal.addEventListener("abort",resolveRevoked,{once:true});
  if(combined.signal.aborted)resolveRevoked();
  let upstream:DuplexByteStream;
  try{upstream=await options.routeOpener.open({runtimeId:binding.runtimeId,runtimeGeneration:route.generation,route:route.route},combined.signal)}
  catch{active.connection.signal.removeEventListener("abort",abortFromConnection);combined.signal.removeEventListener("abort",resolveRevoked);await active.connection.release();return reject(options.transport,combined.signal.aborted?"revoked":"routeOpenFailed")}
  let pumps:readonly Promise<unknown>[]=[];
  try{
   if(combined.signal.aborted){await upstream.close(combined.signal.reason);return reject(options.transport,"revoked")}
   await options.transport.write(encodeTransportHandshakeResult(true));
   if(combined.signal.aborted){await upstream.close(combined.signal.reason);await options.transport.close(combined.signal.reason);return{outcome:"revoked"}}
   const clientBound=new LineBound(),runtimeBound=new LineBound();
   if(remainder.byteLength){clientBound.accept(remainder);await upstream.write(remainder)}
   const clientToRuntime=(async()=>{for(;;){const next=await iterator.next();if(next.done){await upstream.end();return"clientClosed"as const}clientBound.accept(next.value);await upstream.write(next.value)}})();
   const runtimeToClient=(async()=>{for await(const chunk of upstream.readable){runtimeBound.accept(chunk);await options.transport.write(chunk)}await options.transport.end();return"runtimeClosed"as const})();
   pumps=[clientToRuntime,runtimeToClient];
   const first=await Promise.race([clientToRuntime,runtimeToClient,revocation.promise]);
   if(first==="revoked"){await upstream.close(combined.signal.reason);await options.transport.close(combined.signal.reason);await Promise.allSettled(pumps);return{outcome:"revoked"}}
   if(first==="runtimeClosed"){
    const last=await Promise.race([clientToRuntime,revocation.promise]);
    if(last==="revoked"){await upstream.close(combined.signal.reason);await options.transport.close(combined.signal.reason);await Promise.allSettled(pumps);return{outcome:"revoked"}}
    await Promise.all(pumps);return{outcome:"runtimeClosed"};
   }
   const last=await Promise.race([runtimeToClient,revocation.promise]);
   if(last==="revoked"){await upstream.close(combined.signal.reason);await options.transport.close(combined.signal.reason);await Promise.allSettled(pumps);return{outcome:"revoked"}}
   await Promise.all(pumps);return{outcome:"clientClosed"};
  }catch{await upstream.close();await options.transport.close();await Promise.allSettled(pumps);return{outcome:"transportError"}}
  finally{active.connection.signal.removeEventListener("abort",abortFromConnection);combined.signal.removeEventListener("abort",resolveRevoked);await active.connection.release()}
 }finally{
  options.signal?.removeEventListener("abort",abortFromOption);
  combined.signal.removeEventListener("abort",resolveAdmissionCancellation);
 }
}
