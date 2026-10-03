import { z } from 'zod';
import { uuid } from './claude';

export const routineSchema = z.object({
  mode: z.enum(['free', 'research', 'review']).default('free'),
  starts: z.object({ codex: z.enum(['new', 'existing']), claude: z.enum(['new', 'existing']) }).strict().optional(),
}).strict();
export type RoutineInput = z.input<typeof routineSchema>;
export type Routine = { mode: 'free' | 'research' | 'review'; starts: { codex: 'new' | 'existing'; claude: 'new' | 'existing' }; startMode: 'new' | 'existing' | 'mixed'; independence: 'not_guaranteed' };
export function normalizeRoutine(input: RoutineInput | undefined, prior: {codex?: string; claude?: string}): Routine {
  const parsed = routineSchema.parse(input ?? {});
  const starts = parsed.starts ?? { codex: prior.codex?.trim() ? 'existing' : 'new', claude: prior.claude?.trim() ? 'existing' : 'new' };
  for (const agent of ['codex', 'claude'] as const) {
    const supplied = !!prior[agent]?.trim();
    if (starts[agent] === 'existing' && !supplied) throw new Error(`Existing ${agent} analysis requires explicit context.priorAnalysis.${agent} text`);
    if (starts[agent] === 'new' && supplied) throw new Error(`New ${agent} analysis conflicts with supplied prior analysis; choose existing or remove that text`);
  }
  return { mode: parsed.mode, starts, startMode: starts.codex === starts.claude ? starts.codex : 'mixed', independence: 'not_guaranteed' };
}

const targetSchema = z.object({resultId: uuid, version: z.number().int().min(1).max(10000)}).strict();
export const taskSchema = z.object({ taskId: uuid, intent: z.enum(['analyze', 'discuss', 'synthesize', 'review']), target: targetSchema.optional() }).strict()
  .refine(task => task.intent !== 'review' || !!task.target, 'A review task requires an exact result/version target');
export type Task = z.infer<typeof taskSchema>;
const disagreements = z.array(z.string().trim().min(1).max(4000)).max(50).default([]);
export const reportSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('response'), taskId: uuid.optional(), declaredState: z.enum(['analysis', 'perspective', 'needs_input', 'blocked', 'done']), disagreements}).strict(),
  z.object({kind: z.literal('result'), taskId: uuid.optional(), resultId: uuid, version: z.number().int().min(1).max(10000), title: z.string().trim().min(1).max(256), disagreements}).strict(),
  z.object({kind: z.literal('review'), taskId: uuid.optional(), resultId: uuid, version: z.number().int().min(1).max(10000), verdict: z.enum(['agree', 'revise', 'disagree']), disagreements}).strict(),
]);
export type Report = z.infer<typeof reportSchema>;
export const closureSchema = z.object({result: targetSchema.optional(), summary: z.string().trim().min(1).max(4000), disposition: z.enum(['proposal', 'with_disagreements', 'incomplete'])}).strict();
export type Closure = z.infer<typeof closureSchema>;
export const workPrefix = 'CC_CDX_WORK_V1 ';
export function formatWork(work: Task | Report, text: string) {
  const value = 'kind' in work ? reportSchema.parse(work) : {kind: 'task', ...taskSchema.parse(work)};
  return workPrefix + JSON.stringify(value) + '\n' + z.string().trim().min(1).max(32000).parse(text);
}
export function parseWork(text: string): { work: ({kind:'task'} & Task) | Report; text: string } | null {
  if (!text.startsWith(workPrefix)) return null;
  const newline = text.indexOf('\n');
  if (newline < 0 || newline > 220000) throw new Error('Invalid work envelope');
  const raw = JSON.parse(text.slice(workPrefix.length, newline));
  const work = raw.kind === 'task' ? {kind:'task' as const, ...taskSchema.parse(Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='kind')))} : reportSchema.parse(raw);
  const body = z.string().trim().min(1).max(32000).parse(text.slice(newline + 1));
  return {work, text: body};
}

export const routineGuides = {
  free: 'Colaboración libre: adapta análisis, preguntas, propuestas y críticas al objetivo. No hay rondas obligatorias ni roles intelectuales fijos. Conserva desacuerdos útiles.',
  research: 'Investigación: contrasta explicaciones y alternativas con evidencia verificable, distingue hechos de hipótesis y conserva incertidumbres. Elige las comprobaciones que resuelvan las preguntas abiertas.',
  review: 'Revisión: examina el material contra el objetivo y restricciones; identifica problemas concretos, impacto y comprobaciones. Puedes cuestionar el enfoque completo. No fuerces acuerdo ni cambios de archivos.',
};
export function guide(routine: Routine) {
  return { ...routine, guidance: routineGuides[routine.mode], initial: {
    codex: routine.starts.codex === 'existing' ? 'Continúa el análisis Codex explícito; evita repetirlo sin motivo.' : 'Elabora el análisis Codex necesario para este objetivo.',
    claude: routine.starts.claude === 'existing' ? 'Continúa el análisis Claude explícito; evita repetirlo sin motivo.' : 'Elabora el análisis Claude necesario para este objetivo.',
  }, limits: 'Los límites de tiempo y mensajes los aplica el núcleo. Las declaraciones de los agentes no son estados validados ni consenso. No hay barrera de independencia técnica.' };
}
