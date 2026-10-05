# Claude UDS Bridge

This folder holds the plugin itself. For what it does, how to install it, and how to work on it, read the [repository README](../../README.md).

Fork version 0.6.0 adds the authenticated local panel and durable human commands consumed by the actual owner chat. It retains optional structured coordination from 0.5.0: context versions, assigned tasks, initial exchange barrier, pause/resume, controller leases and explicit recovery. The skill keeps free collaboration and optional research/review guidance. Existing chat memory and reception settings still apply. Load both new MCP tools and a receiver advertising `panel_commands_v1`; the panel does not generate intellectual tasks in the background. See [phase 4](../../docs/FASE_4.md).

Implementation and continuity records: [FASE_1.md](../../docs/FASE_1.md) and [FASE_2.md](../../docs/FASE_2.md). The SQLite migration from schema 1 to 2 preserves old runs; their absent routine/report metadata remains absent rather than inferred.

Examples after loading the skill:

- “Work with the Claude Desktop conversation in this project to find a better approach.” (`free`)
- “Research these alternatives together and check the evidence.” (`research`)
- “Review this plan with Claude; retain any disagreement.” (`review`)
- “Continue from these two analyses rather than starting again.” (explicit priorAnalysis, existing/existing)

`collaboration_prepare` accepts optional `routine: {mode, starts: {codex, claude}}`. Starts infer from explicit priorAnalysis when omitted. `collaboration_send` accepts optional `{taskId,intent,target?}`. `collaboration_guide` is read-only. `collaboration_report` records this caller's own authored result/review; Claude's reports are captured from delivered structured messages. `collaboration_finish` can identify the result/version and declared disposition. See the skill's [API reference](skills/bridge-collaboration/references/api.md).

State/export redact incoming content that has not been permitted and delivered. Transport states are observations; report verdicts and closure summaries are agent declarations, never a core-verified agreement.

[PROTOCOL-COVERAGE.md](PROTOCOL-COVERAGE.md) compares this implementation against Claude Code's documented cross-session messaging, case by case.

## Panel local (fase 4)

Desde el chat Codex con el plugin 0.6.0, pide abrir el panel (`collaboration_panel`). Devuelve un enlace privado de localhost. También puedes iniciar el servicio bajo demanda:

```bash
/bin/sh scripts/run-bun.sh dist/cli.js panel
```

Ejecuta el comando desde la carpeta del plugin; `--thread UUID` limita el panel a un chat. El panel permite seleccionar conversaciones Desktop, empezar análisis nuevos o pegar análisis existentes, seguir el intercambio, leer resultados y desacuerdos, exportar Markdown/JSON y solicitar pausa/reanudación/cancelación. Las órdenes se guardan y las aplica el chat propietario con sus herramientas reales. Cierra el proceso con Ctrl+C cuando ya no lo necesites. No se instala un servicio permanente.

Tras actualizar, salir completamente de Codex y volver al mismo chat carga las herramientas nuevas. El panel muestra un requisito de recarga si el receptor aún es antiguo. Un receptor vivo puede sobrevivir a la recarga de la app: en ese caso, pide recargar solo el receptor de ese chat, después de comprobar que no hay colaboraciones activas ni entradas pendientes. El arranque normal lo reutiliza; no lo sustituye automáticamente. No modifica la recepción de Claude ni permisos de ejecución. Los mensajes privados retenidos detrás de la barrera siguen ocultos. Si una aplicación queda interrumpida o la entrega es incierta, muestra diagnóstico; no repite trabajo automáticamente.

Para desarrollar la UI: `cd ui && bun install --frozen-lockfile`; el build del plugin genera backend y `panel-dist/`. La UI utiliza componentes oficiales shadcn/ui obtenidos mediante su MCP; no necesita ese MCP en el entorno de uso.
