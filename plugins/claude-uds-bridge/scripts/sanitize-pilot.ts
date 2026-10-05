import {parseArgs} from 'node:util';
import {readFileSync,statSync,writeFileSync} from 'node:fs';
import {publicPilotEvidence} from '../src/pilot-evidence';
try{
 const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'}},strict:true});
 if(!values.input||!values.output)throw new Error('Use --input private-evidence.json --output shareable-summary.json');
 if(statSync(values.input).size>10*1024*1024)throw new Error('Evidence input exceeds 10 MiB');
 const safe=publicPilotEvidence(JSON.parse(readFileSync(values.input,'utf8')));
 writeFileSync(values.output,JSON.stringify(safe,null,2)+'\n',{mode:0o600});
 console.log('Allowlisted summary written; full transcripts remain private.');
}catch{console.error('Invalid evidence. No summary written. Supply the allowlisted schema documented in docs/PILOTO.md.');process.exitCode=1;}
