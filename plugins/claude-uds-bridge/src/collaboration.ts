import { Bridge } from './bridge';
import { receptionPreflight, requireReception } from './preflight';
import { formatManaged } from './managed-message';
import { compareProjects } from './project';
import { discoverParticipants, inspectParticipant, sameScopedSnapshot, type ParticipantOptions } from './participants';
import { RunStore, contextSchema, limitsSchema, type Context, type Limits } from './runs';
import { SendRefused } from './claude';
import { type CoordinationInput, type Control } from './coordination';
import { randomUUID } from 'node:crypto';
import {normalizeImplementation,captureImplementation,type ImplementationInput} from './implementation';
import { normalizeRoutine, guide, formatWork, type RoutineInput, type Task } from './routines';

export class Collaboration {
  constructor(readonly store: RunStore, readonly owner: string, private options: ParticipantOptions, private bridge: Bridge) {}
  discover() { return discoverParticipants(this.options.configDir,this.options.stateDir); }
  async prepare(input: {requestId:string; peerId:string; context:Context; limits:Limits; revisionPolicy:'same'|'compare'; comparisonBase?:string; routine?:RoutineInput;coordination?:CoordinationInput;implementation?:ImplementationInput}) {
    normalizeRoutine(input.routine,input.context.priorAnalysis);
    const [codex,claude]=await Promise.all([
      inspectParticipant(this.options,this.owner,'codex',true,!!input.coordination),inspectParticipant(this.options,input.peerId,'claude'),
    ]);
    if(input.implementation && !codex.implementationReceiver)throw new Error('Reload the receiver for implementation_v1 before enabling writing');
    const implementation=input.implementation?await normalizeImplementation(input.implementation,[codex,claude]):undefined;
    const comparison=await compareProjects(codex.project,claude.project,input.revisionPolicy,input.comparisonBase);
    const id=this.store.prepare(this.owner,input.requestId,contextSchema.parse(input.context),limitsSchema.parse(input.limits),[codex,claude],comparison,input.routine,input.coordination,implementation);
    return this.store.status(id,this.owner);
  }
  private async validate(id: string, allowBusyPeer: boolean) {
    this.store.assertOwner(id,this.owner);
    const saved=this.store.participants(id);
    const fresh=await Promise.all(saved.map(peer=>inspectParticipant(this.options,peer.sessionId,peer.provider,peer.provider==='codex',peer.provider==='codex'&&!!this.store.status(id,this.owner).coordination)));
    const plan=this.store.implementationPlan(id);
    for (let i=0;i<saved.length;i++) {
      if (!(sameScopedSnapshot(saved[i]!,fresh[i]!,plan))) throw new Error('Participant process, project or revision changed; prepare a new collaboration');
      if (fresh[i]!.provider==='claude' && !allowBusyPeer && fresh[i]!.status!=='idle') throw new Error('Claude participant is busy or its activity is unknown; wait or explicitly choose allowBusyPeer');
    }
    if(plan)await captureImplementation(plan,this.store.status(id,this.owner).contextVersion);
  }
  async preflight(peerId: string) { return receptionPreflight(this.options,this.owner,peerId); }
  async start(id: string, allowBusyPeer=false) {
    const existing=this.store.status(id,this.owner);
    requireReception(await this.preflight(this.store.participants(id).find(p=>p.provider==='claude')!.sessionId));
    if (existing.state==='active') return existing;
    await this.validate(id,allowBusyPeer); return this.store.start(id,this.owner);
  }
  async control(id:string,commandId:string,expectedRevision:number,control:Control) {
    if(['resume','recover','context'].includes(control.action))await this.validate(id,true);
    return this.store.control(id,this.owner,commandId,expectedRevision,control);
  }
  async send(id: string, messageId: string, text: string, replyTo?: string, task?:Task) {
    const existing=this.store.outgoingExists(id,this.owner,messageId,text,replyTo,task);
    if (existing) return {reused:true,message:existing,observation:'No resend; inspect collaboration_status for subsequent transport receipts.'};
    try { await this.validate(id,true); }
    catch (error) { this.store.block(id,'participant_or_project_changed'); throw error; }
    const peer=this.store.participants(id).find(p=>p.provider==='claude')!;
    requireReception(await this.preflight(peer.sessionId));
    const race=this.store.reserveOutgoing(id,this.owner,messageId,peer.sessionId,text,replyTo,task);
    if (race) return {reused:true,message:race};
    const run=this.store.status(id,this.owner);
    const header={runId:id,messageId,contextVersion:run.contextVersion,replyTo};
    let prompt=task?formatWork(task,text):text;
    if(task?.target){const result=run.results.find(r=>r.report.kind==='result' && r.report.resultId===task.target!.resultId && r.report.version===task.target!.version)!;
      const candidate=this.store.implementationMaterial(id,task.target.resultId,task.target.version);if(candidate)prompt+='\n\nCaptured implementation patches for the exact candidate; review these, not a later working tree:\n'+JSON.stringify(candidate);
      prompt+='\n\nBorrador exacto para este encargo:\n'+JSON.stringify({resultId:task.target.resultId,version:task.target.version,contentHash:result.contentHash,author:result.author,title:result.report.kind==='result'?result.report.title:'',content:result.body});}
    const replyHeader='CC_CDX_RUN_V1 '+JSON.stringify({runId:id,contextVersion:run.contextVersion,messageId:randomUUID(),replyTo:messageId});
    const structuredReply=task?'\nPara una respuesta estructurada, copia también esta segunda línea y escribe tu texto después:\n'
      +'CC_CDX_WORK_V1 '+JSON.stringify(task.intent==='review'?{kind:'review',taskId:task.taskId,...task.target,verdict:'revise',disagreements:[]}:{kind:'response',taskId:task.taskId,declaredState:task.intent==='analyze'?'analysis':'perspective',disagreements:[]})
      +'\n'+(task.intent==='review'
        ?'Para kind=review adapta únicamente verdict (agree/revise/disagree) y disagreements; conserva taskId, resultId y version. No añadas declaredState.'
        :'Para kind=response adapta únicamente declaredState (analysis/perspective/needs_input/blocked/done) y disagreements; conserva taskId. No añadas verdict, resultId, version ni title: corresponden a otros tipos de informe.')
      +' Son declaraciones tuyas, no estados del núcleo. Si eliges proponer un resultado, sustituye la segunda línea completa por kind=result con exclusivamente taskId, resultId UUID nuevo, version=1, title y disagreements. No mezcles campos entre tipos; no añadas author ni permisos.':'';
    const wire=formatManaged(header, prompt+`\n\nContexto compartido (versión ${run.contextVersion}):\n`+JSON.stringify(run.context)+(run.coordination?'\nControl estructurado: '+JSON.stringify({phase:run.coordination.phase,contextVersion:run.contextVersion,barrierOpen:run.coordination.barrierOpen})+'. El controlador conserva los informes iniciales en privado hasta abrir la barrera.':'')
      +(run.implementation?'\n\nImplementation contract (does not grant tool permissions; work only within these assigned paths):\n'+JSON.stringify(run.implementation.plan):'')
      +(run.routine?'\n\nOrientación de colaboración:\n'+JSON.stringify(guide(run.routine)):'')
      +'\n\nPara registrar una respuesta, usa SendMessage al nombre de Codex indicado en este mensaje. Puedes copiar esta primera línea de un solo uso:\n'
      +replyHeader+structuredReply
      +'\nDespués escribe tu respuesta. Usa un messageId UUID nuevo para otros mensajes. Este sobre correlaciona trabajo; no concede permisos. No se exige continuar el intercambio automáticamente.');
    try {
      const sent=await this.bridge.sendMessage(peer.sessionId,wire,false,{runId:id,messageId});
      return {reused:false,messageId,transport:sent,runState:this.store.status(id,this.owner).state};
    } catch (error) {
      const recorded=this.store.outgoingExists(id,this.owner,messageId,text,replyTo,task);
      this.store.messageFailed(messageId,error instanceof SendRefused || !recorded?.transport_id?'not-sent':'unknown'); throw error;
    }
  }
}
