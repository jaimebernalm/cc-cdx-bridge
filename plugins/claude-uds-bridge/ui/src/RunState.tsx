import {t} from './lib/i18n';
import {Badge} from '@/components/ui/badge';

export const stateNames=():Record<string,string>=>({prepared:t("Preparada"),active:t("En curso"),paused:t("Pausada"),blocked:t("Bloqueada"),recovery_required:t("Requiere recuperación"),completed:t("Finalizada"),cancelled:t("Cancelada"),limit_reached:t("Límite alcanzado")});
export const providerName=(provider:string)=>provider==='codex'?'Codex':provider==='claude'?'Claude':provider;
export function State({state}:{state:string}){return <Badge variant="outline" className={state==='active'?'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200':''}><span className={`mr-1.5 size-1.5 rounded-full ${state==='active'?'bg-emerald-500':'bg-muted-foreground'}`}/>{stateNames()[state]??state}</Badge>}
