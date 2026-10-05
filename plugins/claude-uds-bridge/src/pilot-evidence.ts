import {z} from 'zod';

// A public evidence summary is a projection, not a redacted transcript. Unknown
// fields (including arbitrary agent text and nested metadata) are never copied.
const semver=z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
const check=z.object({check:z.enum(['types','ui_types','build','source_suite','bundle_suite','marketplace_with_spaces','previous_distribution_installation','update_preserves_private_state','installed_files_match_checkout','installed_launcher_reduced_path','uninstall_removes_cache_preserves_private_state','reinstall_restores_history_command_and_authorization','panel_restart','worktrees','native_roundtrip','native_app_restart','ui_regression']),passed:z.boolean(),count:z.number().int().min(0).optional()});
export const pilotEvidenceSchema=z.object({schemaVersion:z.literal(1),version:semver,platform:z.enum(['darwin','linux']),runtime:semver,
 checks:z.array(check).max(100),realCases:z.array(z.object({case:z.enum(['L01','L02','L03','L04','L05','L06','L07','L08','L09','L10','L11','L12','L13','L14','L15','L16','L17','L18']),outcome:z.enum(['passed','blocked','not_run']),version:semver})).max(18)});
export function publicPilotEvidence(raw:unknown){return pilotEvidenceSchema.parse(raw);}
