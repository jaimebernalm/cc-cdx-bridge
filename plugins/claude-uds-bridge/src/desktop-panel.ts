import {realpathSync} from 'node:fs';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {CreationTickets,ticketInputSchema,grantInputSchema,type PanelActor,type Candidate} from './creation-tickets';
import {inspectParticipant,discoverParticipants,type ParticipantOptions} from './participants';
import type {Principal} from './desktop-runs';
import {consumeCorrelation,peekCorrelation} from './claude-sidecar';

export type DesktopPanelAdapter={principal:Principal;project:string;invoke:(name:string,args:Record<string,unknown>,panelSessionId:string)=>Promise<unknown>};
/** The HTTP router supplies its authenticated panel session, never a model argument. */
export function desktopPanelRoutes(options:ParticipantOptions,adapter:DesktopPanelAdapter,panelSessionId:string){
 const tickets=new CreationTickets(options.stateDir),actor:PanelActor={kind:'panel_session',id:panelSessionId,scope:{project:adapter.project}};
 const selected=async(ticketId:string,sessionId:string)=>{const t=tickets.get(ticketId),p=await inspectParticipant(options,sessionId,t.targetProvider),native=(await discoverParticipants(options.configDir,options.stateDir)).find(x=>x.sessionId===sessionId&&x.provider===t.targetProvider);if(!native?.startedAt)throw new Error('Host session start time is unavailable; do not infer freshness');return {provider:p.provider,sessionId:p.sessionId,pid:p.pid,procStart:p.procStart,project:p.project.directory,branch:p.project.branch,head:p.project.head,startedAt:native.startedAt} satisfies Candidate;};

 const check=async(id:string)=>{const t=tickets.get(id);if(t.project!==realpathSync(adapter.project))throw new Error('Panel project mismatch');if(t.state==='bound'){if(t.correlationId){const receipt=peekCorrelation(options.stateDir,t.correlationId);if(receipt&&receipt.sessionId===t.bound?.sessionId&&receipt.enginePid===t.bound.pid&&receipt.procStart===t.bound.procStart)consumeCorrelation(options.stateDir,t.correlationId);}return {ticket:t,observed:{decision:'already_bound',candidates:[]}};}const available=(await discoverParticipants(options.configDir,options.stateDir)).filter(p=>p.provider===t.targetProvider&&p.cwd===t.project&&p.eligibleSurface&&p.startedAt!==null&&p.startedAt>=t.createdAt);const candidates=await Promise.all(available.map(p=>selected(t.id,p.sessionId)));const observed=tickets.observe(t.id,candidates);if(t.correlationId&&t.targetProvider==='claude'){const receipt=peekCorrelation(options.stateDir,t.correlationId),match=receipt&&candidates.find(c=>c.sessionId===receipt.sessionId);if(receipt&&match)try{const bound=tickets.bindVerified(t.id,match,receipt);consumeCorrelation(options.stateDir,t.correlationId);return {observed,ticket:bound}}catch(error){const current=tickets.get(t.id);if(current.state==='bound'&&current.bound?.sessionId===match.sessionId)return {observed,ticket:current};return {observed,ticket:current,bindingError:error instanceof Error?error.message:'Host receipt rejected'}}}return {observed,ticket:tickets.get(t.id),freshness:t.targetProvider==='codex'?'receiver_start_only_manual_binding_required':'native_engine_start'};};
 return {async handle(path:string,method:string,read:()=>Promise<unknown>){
  if(path==='state'&&method==='GET'){
   const runs=await adapter.invoke('status',{},panelSessionId),participants=await adapter.invoke('discover',{},panelSessionId);
   // Only a host receipt can bind automatically. Polling never starts creation, sends a prompt,
   // changes a grant or guesses Codex freshness from a receiver restart.
   const bindingErrors:Record<string,string>={};
   for(const ticket of tickets.list(adapter.project).filter(t=>t.targetProvider==='claude'&&['awaiting_receiver','ambiguous','creation_uncertain'].includes(t.state)&&t.correlationId)){
    try{const result=await check(ticket.id);if('bindingError' in result&&result.bindingError)bindingErrors[ticket.id]=result.bindingError;}catch(error){bindingErrors[ticket.id]=error instanceof Error?error.message:'Host receipt rejected';}
   }
   return {principal:adapter.principal,project:adapter.project,runs,participants,tickets:tickets.list(adapter.project),grants:tickets.grants(adapter.project),bindingErrors};
  }
  if(method!=='POST')throw new Error('Unknown Desktop panel route');
  const raw=await read();
  if(path==='tickets/request'){const input=ticketInputSchema.parse(raw);if(realpathSync(input.project)!==realpathSync(adapter.project))throw new Error('Panel project mismatch');return tickets.requestFromPanel(actor,input);}
  if(path==='tickets/authorize'){const a=z.object({id:z.string().uuid(),revision:z.number().int()}).strict().parse(raw);return tickets.authorize(actor,a.id,a.revision);}
  if(path==='tickets/cancel'){const a=z.object({id:z.string().uuid()}).strict().parse(raw);return tickets.cancel(actor,a.id);}
  if(path==='tickets/bind'){const a=z.object({id:z.string().uuid(),sessionId:z.string().uuid()}).strict().parse(raw);return tickets.bindManual(actor,a.id,await selected(a.id,a.sessionId));}
  if(path==='tickets/check'){const a=z.object({id:z.string().uuid()}).strict().parse(raw);return check(a.id);}
  if(path==='grants/create')return tickets.grant(actor,grantInputSchema.parse(raw));
  if(path==='grants/revoke'){const a=z.object({id:z.string().uuid()}).strict().parse(raw);return tickets.revokeGrant(actor,a.id);}
  if(!['prepare','preflight','start','control','export','notify','consent','creation_dispatch','implementation'].includes(path))throw new Error('Unknown Desktop operation');
  const args=z.record(z.string(),z.unknown()).parse(raw);if(path==='prepare')args.openPanel=false;return adapter.invoke(path,args,panelSessionId);
 },close(){tickets.close();}};
}
