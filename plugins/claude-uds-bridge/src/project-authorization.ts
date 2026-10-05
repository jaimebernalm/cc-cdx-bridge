import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDirectory } from './claude';

export const authorizationIdentitySchema=z.object({ownerThread:z.string().uuid(),project:z.string().min(1).max(4096)}).strict();
export const authorizationChangeSchema=authorizationIdentitySchema.extend({actionId:z.string().uuid(),enabled:z.boolean(),expectedRevision:z.number().int().min(0),confirmed:z.literal(true)}).strict();
type Change=z.infer<typeof authorizationChangeSchema>;
type Row={project:string;device:string;inode:string;enabled:number;revision:number;updated_at:number;actor:string};
function folder(path:string){const project=realpathSync(path),stat=statSync(project,{bigint:true});if(!stat.isDirectory())throw new Error('Project must be a directory');return {project,device:String(stat.dev),inode:String(stat.ino)};}
export class ProjectAuthorizations {
  private db:Database;
  constructor(stateDir:string,private now=()=>Date.now()){
    mkdirSync(stateDir,{recursive:true,mode:0o700});privateDirectory(stateDir);
    const path=join(stateDir,'project-authorizations.sqlite');
    if(existsSync(path)){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('Project authorization state must be a private owned file');}
    this.db=new Database(path,{create:true,strict:true});chmodSync(path,0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS project_authorizations(project TEXT PRIMARY KEY,device TEXT NOT NULL,inode TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authorization_actions(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  status(path:string){
    const f=folder(path),r=this.db.query<Row,[string]>('SELECT * FROM project_authorizations WHERE project=?').get(f.project);
    const valid=!!r&&r.device===f.device&&r.inode===f.inode;
    return {project:f.project,enabled:valid&&r.enabled===1,revision:r?.revision??0,updatedAt:r?.updated_at??null,actor:r?.actor??null,folderChanged:!!r&&!valid,scope:'managed_same_directory' as const};
  }
  allows(path:string,receivedAt:number){try{const s=this.status(path);return s.enabled&&s.updatedAt!==null&&receivedAt>s.updatedAt;}catch{return false;}}
  change(raw:Change){
    const c=authorizationChangeSchema.parse(raw),f=folder(c.project),payload=JSON.stringify({...c,...f});
    return this.db.transaction(()=>{
      const previous=this.db.query<{payload:string;result:string},[string]>('SELECT payload,result FROM authorization_actions WHERE id=?').get(c.actionId);
      if(previous){if(previous.payload!==payload)throw new Error('Authorization action ID reused with different contents');return {...this.status(f.project),reused:true};}
      const current=this.status(f.project);if(current.revision!==c.expectedRevision)throw new Error('Authorization revision changed; refresh before choosing again');
      const at=this.now();
      this.db.run(`INSERT INTO project_authorizations VALUES (?,?,?,?,?,?,?) ON CONFLICT(project) DO UPDATE SET device=excluded.device,inode=excluded.inode,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at,actor=excluded.actor`,[f.project,f.device,f.inode,c.enabled?1:0,current.revision+1,at,c.ownerThread]);
      const result=this.status(f.project);this.db.run('INSERT INTO authorization_actions VALUES (?,?,?,?)',[c.actionId,payload,JSON.stringify(result),at]);return {...result,reused:false};
    }).immediate();
  }
  close(){this.db.close();}
}
