// Bundles the Claude Code Desktop entrypoints into the self-contained Claude plugin root. That
// root is kept apart from this Codex plugin because Claude merges a plugin's default
// hooks/hooks.json and .mcp.json with whatever its manifest declares.
import { copyFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dir, '..'), target = join(here, '../cc-cdx-bridge-claude');
const result = await Bun.build({
  entrypoints: [join(here, 'src/claude-server.ts'), join(here, 'src/claude-hook.ts')],
  target: 'bun', minify: true, outdir: join(target, 'dist'),
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
copyFileSync(join(here, 'scripts/run-bun.sh'), join(target, 'scripts/run-bun.sh'));
// The shared panel serves its built assets from <pluginRoot>/panel-dist.
rmSync(join(target, 'panel-dist'), { recursive: true, force: true });
cpSync(join(here, 'panel-dist'), join(target, 'panel-dist'), { recursive: true });
rmSync(join(target,'skills'),{recursive:true,force:true});
cpSync(join(here,'skills'),join(target,'skills'),{recursive:true});
console.log(result.outputs.map(output => output.path.slice(target.length + 1)).join('\n'));
