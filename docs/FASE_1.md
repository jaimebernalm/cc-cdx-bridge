# Fase 1 — Pareja de conversaciones y registro de colaboración

## Estado y continuidad

Autorizada por el usuario el 2026-10-03: planificar e implementar la fase 1 del plan general. Fase 0 permanece en el árbol de trabajo, sin publicar. No borrar esos cambios. Este archivo es el punto de recuperación del trabajo: actualizar las casillas, decisiones, pruebas y límites antes de terminar o cambiar de contexto.

Fase 1 terminada como distribución 0.3.0; suite de fuente y bundles, instalación aislada e ida y vuelta gestionada real verificadas. El bloqueo inicial de recepción descrito más abajo se resolvió con la elección posterior del usuario: Claude global `accept` y recepción `accept` solo en el receptor del chat Codex. La recarga de la app comprobó las ocho herramientas gestionadas y recuperación del registro. La distribución actual es 0.4.0 de [fase 2](FASE_2.md), autorizada posteriormente; este documento conserva las evidencias y límites de la entrega 0.3.0.

## Alcance

Implementar los siete requisitos de fase 1: descubrimiento con superficie/proceso, repositorio/worktree/revisión, ejecución y participantes/contexto/eventos persistidos, exclusión de ejecuciones activas por conversación, mensajes gestionados, límites previos a entrega y exportación Markdown/JSON. Añadir preparación/inicio/estado y controles de cancelación/cierre. Mantener el transporte y herramientas originales para conversaciones ajenas a una ejecución gestionada.

No implementar aún presets, skills de debate, barrera de análisis independiente, revisión de conclusiones, UI ni supervisor automático. El registro no afirma que una entrega implique consumo del modelo. Compartir trabajo ya realizado será posible como texto explícito del contexto o de un mensaje; no importar historiales.

## Arquitectura y decisiones

1. `src/project.ts`: inspección local Git de solo lectura. Ruta canónica, raíz y directorio común del repositorio, HEAD/rama, estado y huella del diff. Carpetas sin Git conservan identidad de ruta con limitación explícita. No guardar remotos ni diffs íntegros. Archivos no rastreados se listan, sin prometer un snapshot de contenido. Las referencias explícitas del contexto no disparan lectura de archivos.
2. `src/participants.ts`: descubrir registros vivos verificando PID + tiempo de inicio; enriquecer superficie y versión. Para selección, exigir UUID exacto y un único registro. Claude debe ser Desktop; Codex es el caller MCP y debe tener propietario nativo/receptor coherentes. Revalidar en inicio y cada envío; no sustituir procesos reiniciados por su nombre. Comparar repositorio y revisión. Worktrees distintos requieren relación verificable y política de comparación con base fijada.
3. `src/runs.ts`: SQLite privado junto al estado del transporte, no en el checkout ni en la caché del plugin. Esquema versionado con ejecuciones, participantes, mensajes, eventos y reservas exclusivas de chats. Transacciones `IMMEDIATE` para reclamar participantes y presupuesto. Las preparaciones no ocupan chats hasta iniciar. Guardar contexto versión 1; las mutaciones/versionado avanzado llegan después.
4. `src/collaboration.ts`: servicio de preparación/inicio/envío/consulta/cancelación/cierre/exportación. La preparación y el inicio no envían trabajo del modelo. El modo supervisado reconoce recepción desconocida y no concede permisos. Si la pareja está retenida, rechazada o con resultado incierto, bloquear encargos siguientes y conservar el motivo.
5. Integración en `Bridge`: registrar recibos autenticados y respuestas con un sobre mínimo `CC_CDX_RUN_V1` que correlacione ejecución/mensaje/respuesta. La autoría procede del transporte verificado, nunca del JSON del agente. Revisar límites y estado también al entregar respuestas retenidas a Codex. Mientras una pareja esté reservada, el envío de texto por la herramienta sin gestión se rechaza para impedir saltarse el presupuesto.
6. MCP: `collaboration_discover`, `collaboration_prepare`, `collaboration_start`, `collaboration_status`, `collaboration_send`, `collaboration_cancel`, `collaboration_finish`, `collaboration_export`. Los controles se restringen al caller propietario. Las exportaciones se devuelven como texto: no escribir automáticamente en el proyecto.

## Invariantes

- Seleccionar IDs exactos; nombres duplicados no se resuelven por aproximación.
- Preparación idempotente por UUID de petición y envío idempotente por UUID de mensaje. Repetir con contenido distinto produce error; resultado incierto no provoca reenvío.
- Solo una ejecución activa/bloqueada puede reservar una conversación. Cancelación, cierre o presupuesto agotado liberan reservas.
- Antes de admitir una entrega nueva se comprueban estado, plazo, presupuesto, emisor/destinatario, contexto y proceso. Registrar la intención y el gasto antes de tocar el transporte.
- Una cancelación impide admisiones nuevas. Una entrega ya admitida o escrita puede terminar; no prometer retirar instrucciones que una app ya recibió. Registrar mensajes tardíos sin volver a entregarlos.
- Un mensaje recibido sin correlación no se presenta como respuesta de la colaboración. Un sobre falso, de otro chat o de versión incompatible no cuenta como respuesta válida.
- Límites por defecto: 24 mensajes gestionados y 30 minutos. Consumen presupuesto las admisiones de mensajes de ambos participantes. Los intentos inciertos conservan su gasto. No se imponen rondas intelectuales.
- Los estados de transporte se guardan separados del estado de ejecución; `socket-written`, `held` o `idle` no significan respuesta/consumo.
- Estado reconstruible al abrir otra conexión al mismo SQLite. Intenciones incompletas se muestran inciertas y no se reintentan automáticamente. Recuperación avanzada, leases y transacciones distribuidas quedan para fase 3.
- No cambiar configuración de Claude, permisos de ejecución ni confianza de hooks. No publicar ni enviar mensajes reales adicionales para validar este núcleo.

## Secuencia de trabajo

- [x] P1.1 Identidad Git y descubrimiento enriquecido, con errores y límites de lectura.
- [x] P1.2 Esquema privado/versionado, contexto, participantes, eventos y exclusión por chat.
- [x] P1.3 Preparación/inicio y revalidación de identidad/revisión.
- [x] P1.4 Rutas gestionadas y correlación de recibos/respuestas en el receptor.
- [x] P1.5 Cancelación/cierre, límites previos e idempotencia sin reenvíos inciertos.
- [x] P1.6 API MCP y exportación legible/estructurada.
- [x] P1.7 Pruebas de fallos y concurrencia, tipos, bundles e instalación aislada.
- [x] P1.8 Documentación final, actualización del plan general y distribución local.

## Plan de validación

Usar sockets reales, SQLite y procesos MCP/hook con contraparte Desktop simulada; etiquetar estos resultados como fixtures, no como diálogo nuevo entre las dos apps. Probar homónimos/selección exacta, PID cambiado y superficie incorrecta; repositorio/worktrees/revisiones y carpeta sin Git; dos controladores reclamando el mismo chat; límite/plazo/cancelación y mensaje tardío; repetición de petición y resultado incierto; recibos autenticados y respuesta correlacionada; mensajes sin correlación y sobre de otro participante; reconstrucción tras cerrar/reabrir; exportación que preserve orden/identidad sin configuración privada. Ejecutar suite de fuente y bundles, tipos e instalación aislada. Una inspección real de preparación, sin envíos, podrá comprobar el proyecto disponible.

## Registro de resultados

Implementación final:

- `project.ts`, `participants.ts`, `managed-message.ts`, `runs.ts`, `collaboration.ts`.
- `Bridge` registra el texto transportado y su huella, recibos y respuestas, además del contenido lógico. El receptor y su socket de salida comprueban la gestión. Un resultado remoto retenido no aparece como aprobación entrante local.
- Los receptores nuevos anuncian `managed_runs_v1` en su estado local, asociado al PID y tiempo de inicio que posee el receptor. No se añade una característica desconocida al registro que consume Claude. La preparación bloquea receptores anteriores: cargar el MCP nuevo no escribe por sí solo esa capacidad ni basta para confiar en el proceso viejo.
- Los avisos idle de un participante gestionado se registran como eventos de transporte; no crean un turno fuera del presupuesto.
- Las respuestas de Claude deben conservar el sobre. `collaboration_send` añade las instrucciones mínimas para devolverlo con `SendMessage`; no inicia un bucle automático. Un mensaje sin correlación de la pareja activa se registra como no atribuible y no se entrega al modelo.
- No hay lectura automática de los archivos citados, snapshots de archivos no rastreados ni barrera intelectual. Los diffs del índice y del árbol se fingerprintan por separado; se desactivan diff externo, textconv y fsmonitor para la inspección. Repositorios bare y errores de inspección se rechazan.
- Una intención persistida incompleta se muestra incierta. Un intento de iniciar otro envío bloquea la ejecución en vez de ignorarla o reintentar el anterior. La reconciliación avanzada queda en fase 3.
- Los límites por plazo se materializan al consultar o intentar una operación; no hay un supervisor despertando las apps. Los sockets comprueban el plazo inmediatamente antes de admitir una escritura y la entrega entrante lo comprueba antes de llamar al IPC nativo.

Resultados del 2026-10-03:

| Comprobación | Resultado | Alcance |
| --- | --- | --- |
| Tipos | `bun run check` correcto | Fuente, scripts y pruebas |
| Suite completa de fuente | 61 pruebas, 509 aserciones, 0 fallos | Incluye 12 pruebas nuevas de fase 1 |
| Suite con servidor/hook de `dist/` | 61 pruebas, 509 aserciones, 0 fallos | MCP, receptor, cancelación y reconstrucción entre procesos |
| Instalación nueva aislada | 0.3.0 instalada y habilitada; archivos idénticos; PATH reducido funciona | Sin auth copiada, confianza de hooks, mensajes ni ajustes Claude |
| Inspección de la pareja actual mediante MCP 0.3.0 | 8 herramientas nuevas disponibles; receptor actual sin `managed_runs_v1`; preparación bloqueada con diagnóstico de recarga | Sin activar receptor ni enviar mensajes/modelo |

La suite usa sockets, SQLite, Git, procesos independientes y un host Desktop simulado. Los reportes privados están en `.local/phase1/`; el comprobador de instalación reutiliza `.local/phase0/installation-*/`.

Comprobación operativa posterior, 2026-10-03: el usuario aplicó `crossSessionInbound: "accept"` en los ajustes de usuario de Claude. Se verificó el archivo sin modificarlo y se recargó únicamente el receptor de este chat Codex mediante los hooks instalados 0.3.0, tras comprobar identidad, proyecto y ausencia de reservas o entradas pendientes. El receptor nuevo anunció `managed_runs_v1`; no se creó ningún chat ni se cerraron las apps.

Un cliente MCP local 0.3.0, vinculado a este mismo chat, preparó e inició una colaboración supervisada de dos mensajes y diez minutos entre las conversaciones Desktop existentes. Envió una sola comprobación. Claude la recibió y devolvió una respuesta correlacionada: el receptor Codex la registró como retenida, sin entrega al modelo. La aprobación solicitada mediante el MCP antiguo todavía cargado devolvió `decline`; el mensaje de transporte quedó rechazado. Se canceló la colaboración y se liberaron las reservas. Esto acredita recepción en Claude y retorno al receptor Codex, pero no contenido correcto de la respuesta ni ida y vuelta entregada a ambos modelos. El registro gestionado conserva `held` porque la resolución se hizo por el MCP antiguo, que no actualiza el registro de fase 1. La app todavía debe recargar sus herramientas MCP para usar normalmente la API nueva. Evidencia privada: `receiver-reload.json`, `managed-smoke.json` y `managed-smoke.md` en `.local/phase1/`.

Después, el usuario autorizó expresamente recepción `accept` en el puente de este chat Codex. Se aplicó solo a su receptor, sin cambiar permisos de ejecución ni edición, sin liberar el mensaje rechazado ni reenviar la ejecución cancelada. Se preparó una colaboración nueva, con dos mensajes y diez minutos. Claude recibió el reto `41 + 67` y devolvió una respuesta con el sobre de la ejecución nueva, `replyTo` correcto, nonce coincidente y resultado `108`. La respuesta entró en esta misma conversación Codex por el IPC nativo y el agente la verificó. La ejecución quedó `completed`, con una salida y una entrada admitidas y ninguna reserva pendiente. El registro gestionado marca entrada `delivered` y el transporte local `steered`: la verificación del contenido procede también de la entrada real recibida por el agente, no de deducir consumo a partir del socket. La prueba inicial rechazada se conserva en `managed-smoke-denied.md`; la prueba positiva y su exportación están en `managed-smoke.json` y `managed-smoke.md`. `codex-reception.json` documenta el alcance del ajuste autorizado. Esto verifica una ida y vuelta gestionada entre las apps; no un debate prolongado, una UI ni los presets de fases posteriores.

## API entregada

| Herramienta | Datos y efecto |
| --- | --- |
| `collaboration_discover` | ID exacto, nombre, proveedor, superficie, PID/inicio, versión, estado y capacidad del receptor. No importa historial. |
| `collaboration_prepare` | `requestId`, `peerId`, `context`, `limits`, `revisionPolicy`, `comparisonBase` opcional. Guarda preparación; no reserva ni envía. |
| `collaboration_start` | `runId`, `supervised: true`, `allowBusyPeer` opcional. Revalida identidad/revisión y reserva los dos chats. |
| `collaboration_status` | `runId` opcional. Detalle reconstruido o lista de ejecuciones del caller. |
| `collaboration_send` | `runId`, `messageId`, `text`, `replyTo` opcional. Envía una vez al participante Claude elegido. `replyTo` debe referir una entrada admitida de esa ejecución. |
| `collaboration_cancel` | `runId`, motivo opcional. Libera reservas y bloquea admisiones nuevas. |
| `collaboration_finish` | `runId`, motivo. Registra cierre explícito; no certifica consenso. |
| `collaboration_export` | `runId`, formato `markdown`/`json`. Devuelve el registro privado, sin escribirlo ni publicarlo. |

La identidad Codex se obtiene de los metadatos del caller. No existe un argumento que permita controlar una ejecución ajena eligiendo otro chat. Los UUID de petición/mensaje son claves de correlación e idempotencia, no autorizaciones humanas.

## Workflow completo de esta fase

1. Cargar 0.3.0 y un receptor nuevo con `managed_runs_v1`; verificar descubrimiento. El plugin y el receptor que ya estaban en memoria requieren recarga, normalmente reiniciando Codex. No se pierde el historial de las conversaciones.
2. Elegir por ID una conversación Claude Desktop Code. Si su proceso/revisión cambia después, preparar de nuevo; no buscar otra conversación de igual título.
3. Preparar objetivo, restricciones, referencias y, si se desea, los dos análisis existentes como texto explícito. Por defecto: misma revisión, 24 mensajes y 30 minutos. Para comparar worktrees/revisiones diferentes: política `compare` y commit base local fijado.
4. Revisar el diagnóstico de recepción. Iniciar en modo supervisado reserva las conversaciones, pero no envía trabajo ni permite cambiar permisos. Si Claude está ocupado, esperar o elegir expresamente incorporarlo con `allowBusyPeer`.
5. Enviar un primer mensaje gestionado. Claude recibe contexto y guía de correlación. Su respuesta con sobre válido se registra por la identidad real de su proceso y se entrega si su recepción en Codex lo permite. Codex puede responder con otro envío gestionado y `replyTo`.
6. Consultar estados/eventos. Una retención, rechazo, resultado incierto o cambio de identidad/proyecto bloquea encargos nuevos. No arreglarlo mintiendo sobre permisos ni reintentando a ciegas. Cancelar/cerrar y preparar otra ejecución después de resolver la causa.
7. Cancelar si se abandona el objetivo, o cerrar con un motivo al terminar. Exportar para leer o guardar el intercambio; el usuario elige dónde escribirlo y qué compartir.

Este flujo permite coordinar manualmente desde el chat con herramientas. La skill para reconocer una instrucción natural, los presets y la coordinación intelectual guiada llegan en fase 2. La recepción elegida por el usuario ya permitió la prueba real de ida y vuelta: `accept` global en Claude y `accept` solo en el receptor de este chat Codex. Las herramientas MCP de la app necesitan recarga para usar normalmente la API nueva; el ensayo utilizó un cliente MCP local 0.3.0 asociado al chat existente.

Recarga de la app comprobada posteriormente el 2026-10-03: tras cerrar y abrir Codex, las ocho herramientas `collaboration_*` aparecen en el catálogo real de este chat. `collaboration_discover` identifica su receptor nuevo con `managed_runs_v1` y la misma conversación Claude Desktop del proyecto. `status` conserva recepción `accept`, sin mensajes retenidos ni entradas pendientes. `collaboration_status` recupera la prueba anterior como `completed`, con sus dos mensajes y diez eventos. No se envió otra prueba ni se cambiaron ajustes durante esta verificación. La recarga pendiente descrita arriba queda resuelta.

## Punto de recuperación al terminar fase 1 (histórico)

La petición posterior del usuario autorizó fase 2 y llevó la distribución a 0.4.0 y el esquema SQLite a 2. Para recuperar el estado actual, usar [FASE_2.md](FASE_2.md); las indicaciones siguientes registran el estado de cierre de fase 1.

- Fase 1 de código completada. No implementar fase 2 sin una petición nueva.
- Distribución local 0.3.0; marketplace/identidad del transporte conservados. Cambios todavía sin publicar.
- El receptor actual usa 0.3.0 y tiene capacidad verificada; las ocho herramientas MCP de fase 1 están disponibles en la app tras su reinicio comprobado. La recepción `accept` de este chat se conservó. No crear otro chat ni ampliar recepción basándose en autorizaciones antiguas.
- La ida y vuelta real gestionada pasó tras las decisiones humanas de recepción, y la recarga recuperó correctamente su registro mediante las herramientas de la app. Fase 1 lista para usar desde este chat. No reenviar las pruebas cerradas ni liberar la respuesta rechazada. Las comprobaciones actuales no prueban debate prolongado entre modelos.
- Estado interno: `$CODEX_HOME/plugin-state/claude-uds-bridge/collaborations.sqlite`, esquema 1. No colocarlo en Git ni en la carpeta cacheada del plugin. Bases de transporte por chat conservadas.
- Ante fallo: revisar primero `phase1.test.ts`, versiones/capacidades de los procesos y eventos de la ejecución. No liberar reservas de una ejecución ajena ni reenviar una intención incierta.
