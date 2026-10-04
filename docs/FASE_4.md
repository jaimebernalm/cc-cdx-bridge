# Fase 4 — Panel local conectado

## Punto de recuperación

Autorizado: planificar, implementar, instalar y probar el panel. Rama `feature/phase-4-local-panel`, desde main `d1ab650` (PR #2 y #3 fusionadas). No publicar PR ni fusionar sin instrucción nueva. No cambiar permisos/recepción. No crear chats de prueba. Preservar los chats Desktop elegidos y datos existentes.

Estado: implementación completada y validada localmente el 4 de octubre de 2026. Distribución 0.6.0 instalada. Rama pendiente de revisión/publicación; arranque desde chat real idle confirmado; retorno de Claude al nuevo chat detenido por su recepción default. Matriz ampliada de piloto pendiente. `.local/phase4` contiene evidencia privada, no se publica.

## Diseño y decisiones

- UI React/Vite, TypeScript y Tailwind, componentes auténticos shadcn/ui. Usar MCP oficial `shadcn mcp` mediante cliente stdio local para buscar/ver componentes y obtener comandos de instalación; no modificar la configuración global de Codex. Documentación: https://ui.shadcn.com/docs/mcp y https://ui.shadcn.com/docs/installation/vite.
- Panel Bun limitado a `127.0.0.1`, puerto asignado, acceso con secreto aleatorio por sesión. Token en fragmento de URL, eliminado de la barra al conectar; cookie HttpOnly SameSite=Strict. Validar Host/Origin, token CSRF para cambios, no CORS abierto, CSP, límites de cuerpo, rutas estáticas cerradas y escapado React. HTML no incluye historiales ni secretos.
- Panel conectado a la misma base de ejecuciones. Lista, detalle, eventos paginados, SSE con cursor/reconexión, resultado/revisiones/desacuerdos, Markdown/JSON, diagnóstico saneado.
- No cambiar las garantías de fase 3. Barrera y mensajes redactados permanecen redactados. Estados de transporte/revisión no prueban rigor, lectura ni consenso. No importar historiales de apps.
- Órdenes UI durables en base privada separada (`panel.sqlite`). UUID idempotente y revisión esperada, objetivo/inputs persistidos. El panel no inventa metadatos MCP ni roba leases del chat.
- Selector exacto de chats disponibles y proyecto; inicio/despertar mediante IPC nativo con identidad/proyecto/proceso revalidados. Requerir capacidad nueva del receptor antes de despertar. El agente del chat elegido consume la orden mediante herramienta MCP vinculada a los metadatos reales. Preservar permisos. Ante ACK incierto registrar unknown, no reenviar.
- Los botones indican solicitud en cola hasta aplicación confirmada. Nuevo run se prepara/inicia con el mismo Collaboration del agente, que conserva su lease y elige tareas intelectuales. Pausa/reanudar/recuperar/cancelar/contexto son órdenes al propietario, no falsos estados inmediatos. Cambios con pantalla obsoleta devuelven conflicto.
- Punto inicial por agente new/existing; existing requiere recapitulación pegada explícitamente. Libre predeterminado; research/review opcionales; barrera opcional solo new/new. Límites visibles. Continuar crea nueva orden con vínculo al run previo, contexto/presupuesto explícitos y revisión nueva de participantes.
- Servicio bajo demanda: comando CLI y herramienta de panel. No instalar daemon permanente ni modificar apps ajenas. Cerrar servicio invalida credenciales, conserva cola/historial. UI y assets empaquetados en plugin.

## Bloques de trabajo

- [x] P4.1 MCP shadcn: conexión, búsqueda, componentes, fuentes y evidencia local.
- [x] P4.2 API de lectura/auth/SSE/export y pruebas de seguridad/reconexión.
- [x] P4.3 Cola durable idempotente y consumo MCP por propietario verificado, wake IPC.
- [x] P4.4 UI inicio/nueva colaboración/detalle/resultado/diagnóstico, accesibilidad/responsive/tema.
- [x] P4.5 Integración CLI/MCP/skill, assets/bundles e instalación aislada.
- [x] P4.6 Pruebas completas source/dist, fixture nativo idle/control, navegador con datos reales.
- [x] P4.7 Instalación local y validación app: verificar herramientas tras recarga; si la recarga requiere al usuario, conservar fuente y documentar estado exacto.

## Matriz mínima de aceptación

1. Sin credencial no se leen sesiones/run/transcripciones; otro origen/Host no actúa; entradas/render no ejecutan HTML.
2. POST duplicado devuelve mismo commandId/run y no genera segundo despertar; UUID diferente con contenido igual es una orden nueva explícita.
3. Desconexión/reload SSE reconstruye desde cursor sin duplicados, snapshots refrescan estado.
4. Inicio desde fixture chat idle llega una vez al IPC nativo, propietario real aplica orden y herramientas comunes; otro thread no puede consumirla; receptor sin capacidad informa recarga.
5. Lease ajeno/unknown no se fuerza. Crash tras reclamar orden queda incierto, no se repite. Control CAS obsoleto rechazado.
6. Modo mixto/existing requiere textos y muestra sus límites; no se expone contenido privado detrás de barrera.
7. Pausa/cancelación no promete interrumpir herramientas ya ejecutándose. Export parcial/reviews obsoletas/desacuerdos visibles.
8. Navegador real: seleccionar/listar/leer/exportar, nueva colaboración y errores; estrecho/teclado/tema. Prueba en apps reales solo sobre pareja ya elegida, objetivo acotado y sin editar archivos.

## Próxima acción tras pérdida de contexto

Consultar git status y este checklist. No repetir colaboraciones completadas. Leer src/panel*.ts, UI y tests nuevos antes de avanzar. Guardar evidencia privada y actualizar resultados aquí. La autorización cubre fase 4 y pruebas, no publicación/merge de otra PR.

## Contrato implementado

- `src/panel.ts`: servicio loopback, autenticación, lectura, exportación y wake nativo. El proceso del panel no toma el lease intelectual del agente.
- `src/panel-commands.ts`: SQLite privada separada con cola durable. Identidad de proceso durante wake/aplicación; proceso muerto queda `unknown` o `application_uncertain`. Repetir commandId con contenido distinto se rechaza. Repetir una aplicación confirmada devuelve su resultado. Aplicación interrumpida no se repite.
- `collaboration_panel`: abre panel vinculado al caller real; `collaboration_panel_command`: solo acepta UUID y aplica contenido persistido tras validar caller/proyecto. No acepta metadatos fabricados ni un owner arbitrario.
- `cli.ts panel [--thread UUID]`: servicio bajo demanda; sin thread permite selector de chats locales. El servicio no está instalado como daemon y no genera investigación en segundo plano.
- Receptor anuncia `panel_commands_v1`; el panel exige recarga si falta. No se interpreta como prueba de que el modelo dispone de herramientas o ha leído contenido; la comprobación del catálogo real se hace tras recargar.
- UI en `ui/`; assets empaquetados en `panel-dist/`. shadcn MCP consultado con SDK stdio (registry/search/view/add-command) e instalado con CLI oficial 4.21.1. Doce componentes new-york/neutral, tema claro/oscuro, acento verde, iconos lucide. Evidencia en `.local/phase4/shadcn-mcp.jsonl`.

### Rutas reales

| Ruta | Operación |
| --- | --- |
| POST /api/v1/session | Canjear secreto de fragmento por cookie HttpOnly y CSRF |
| GET /api/v1/health, participants, presets | Versión, sesiones verificadas y orientaciones disponibles |
| POST /api/v1/preflight | Validar pareja, contexto, recepción observable y capacidad del receptor sin enviar |
| GET /api/v1/runs, runs/:id | Estado desde el núcleo y barrera/redacciones existentes |
| GET /api/v1/runs/:id/events?after=N | Eventos, hasta 100 por página, cursor estable |
| GET /api/v1/runs/:id/stream | SSE con cursor/Last-Event-ID y heartbeat; sin generar tareas |
| GET /api/v1/runs/:id/export?format=markdown/json | Descarga del estado/transcripción autorizado; no publicación |
| GET/POST /api/v1/commands | Consultar/enqueue durable; las órdenes controlan el mismo backend mediante el agente propietario |
| POST /api/v1/diagnostic | Diagnóstico saneado, sin cambios de ajustes ni desafío |

Las rutas orientativas del plan original se concretan en una única cola de comandos para evitar simular al caller o competir por su lease. `create` incluye objetivo/pareja/rutina/starts/contexto/límites, y `continuedFrom` opcional. `pause/resume/recover/cancel/input` requieren runId y expectedRevision. La UI muestra espera hasta confirmación real. `input` versiona el contexto, no concede edición de archivos. Puede cancelar incluso si la ejecución terminó a medias. Una nueva orden tras un fallo requiere inspección del estado, nunca un reenvío ciego.

## Evidencia de aceptación

- MCP shadcn respondió; fuentes de componentes auténticas guardadas en ui/src/components/ui.
- Navegador con ledger real: nueve ejecuciones anteriores visibles; resultado/revisiones v1 y v2, desacuerdos, continuation con textos atribuidos y recarga sin pérdida del detalle.
- Navegador aislado con fixture nativo: inicio desde botón, chat idle activado una sola vez, pausa/resume, instrucción cambia a contexto 2, reload preserva estado sin POST adicional, cancelación confirmada. El contenido `<script>` se muestra literal; no ejecuta HTML.
- Suite panel: auth/Origin/CSRF/cuerpo/rutas, idempotencia, caller equivocado, CAS obsoleto, receptor antiguo, cierre/reinicio, ACK perdido, consumo por ID exacto y apertura MCP sin tareas.
- Prueba real 0.6.0 después de recargar herramientas y receptor: botón Iniciar → orden durable → notificación IPC en este chat → `collaboration_panel_command` con caller MCP real → ejecución activa. Pausa y reanudación confirmadas desde UI. Instrucción añadió contexto 2. Resultado Codex v1 recibió review de Claude de versión/hash exactos (`agree`, sin desacuerdos); cierre conserva `validatedConsensus:false`. Dos mensajes de seis admitidos, cero encargos pendientes, reservas liberadas. Se conserva la limitación declarada de Claude: no auditó la UI ni observó sus acciones.
- Exportación JSON descargada desde el enlace de la UI y comprobada: completed, contexto 2, una review, consenso no validado. Recarga conserva detalle y no crea órdenes. Evidencia privada en `.local/phase4/real-panel-export.json`.
- Fuente: `bun test` — 118 pruebas, 0 fallos, 885 aserciones. Bundles: `UDS_MCP_TEST_ENTRYPOINT="$PWD/dist/server.js" UDS_HOOK_TEST_ENTRYPOINT="$PWD/dist/hook.js" bun test` — mismo resultado. Tipos backend y UI correctos. La variable `BRIDGE_TEST_DIST` no selecciona bundles; no usarla para repetir el ensayo.
- Instalación aislada mediante CLI real: versión 0.6.0, hashes de fuentes distribuidas/assets correctos, launcher funciona con PATH reducido. Instalación habitual actualizada sin cambiar recepción ni permisos.
- Seguridad adicional: dos paneles en puertos distintos usan cookies distintas y no se invalidan entre sí; regresión incluida en la suite. Se corrigió cierre durante wake para esperar las operaciones pendientes.
- Responsive observado en 420, 750 y 1280 px: sin desbordamiento horizontal. En ventanas intermedias el detalle pasa a una columna; navegación móvil usa tres botones visibles. Tema claro/oscuro y diagnóstico saneado comprobados.
- La fixture idle usa sockets/IPC reales con modelo simulado. La primera prueba Desktop llegó como steering durante un turno activo. Ensayo adicional solicitado por el usuario: se creó «Prueba de inicio inactivo — fase 4», se inicializó el plugin y se dejó terminar el turno. El snapshot nativo confirmó idle antes de pulsar Iniciar. El panel activó un nuevo turno en el chat exacto, la orden se aplicó y aparece consumida una sola vez por su clientId nativo. Codex registró la suma y pidió una revisión; la respuesta de Claude quedó held/denied porque el receptor nuevo conserva default y las clases prompting/bypass difieren. El núcleo ocultó el contenido y el chat cerró con disposition incomplete, sin atribuir una revisión. No se cambiaron ajustes. Evidencia privada: idle-before.json, idle-evidence.json, idle-partial-export.json. La repetición del retorno requiere autorización humana para accept temporal solo en ese chat, con restauración posterior.


## Recuperación y siguiente paso

1. No repetir la colaboración cerrada de aceptación. El panel permanece abierto en el navegador y su servicio vive con este proceso MCP; al reiniciarlo se obtiene un enlace privado nuevo. Datos y órdenes sobreviven.
2. Herramientas requeridas: `collaboration_panel` y `collaboration_panel_command`. Receptor requerido: `panel_commands_v1`, además de las capacidades anteriores. Se verificaron en el catálogo y registro reales.
3. Al recargar la app apareció el catálogo nuevo pero permaneció el receptor antiguo. Se comprobó identidad nativa/proyecto, ausencia de reservas/entradas pendientes y se guardó copia de la base; después se ejecutaron los hooks instalados SessionEnd/SessionStart solo para este chat. Ajustes Claude byte a byte iguales y ningún chat creado. Evidencia privada: `receiver-reload.json`. No afirmar que recargar la app garantiza reemplazar todo receptor vivo.
4. Mantener la rama `feature/phase-4-local-panel`; revisar diff, tipos, builds y comprobaciones. Preparar PR solo cuando el usuario lo pida. No fusionar ni publicar automáticamente.
5. Fase 5: completar retorno autorizado del ensayo idle si procede, reinicios de apps/servicio, actualización segura de receptores, múltiples proyectos/worktrees y matriz L01–L16. La incertidumbre de recepción efectiva que `doctor` muestra no se resuelve cambiando ajustes sin autorización.
