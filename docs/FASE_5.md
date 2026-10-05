# Fase 5 — Piloto repetible y recuperación

Rama: `feature/phase-5-pilot-hardening`. Base: `2341cb6` (fase 4 fusionada). La publicación del piloto y su PR se decidirán después; esta fase prepara y prueba la distribución local. No instala un servicio permanente.

## Objetivo y reglas de trabajo

Hacer repetibles instalación, actualización, reapertura, uso desde el panel y diagnóstico. Una entrega incierta se inspecciona, nunca se reenvía automáticamente. Las pruebas no sustituyen las conversaciones Desktop por procesos de modelos CLI. La recepción recordada para este proyecto, autorizada por el usuario, permanece activada; la política explícita de cada chat y los ajustes de Claude se conservan.

No cerrar Codex mientras este turno está trabajando: se perdería el controlador que ejecuta la prueba. Guardar primero el estado y utilizar el chat de prueba existente para los ensayos. Los fallos de IPC, caída de receptor, pérdida de ACK y recuperación de control se fuerzan en entornos aislados. Registrar aparte el cierre/reapertura real de una app; una simulación o reinicio de receptor no cuenta como reinicio de app.

## Plan de implementación

1. **Inventario y diagnóstico.** Revisar distribución, receptor, UI, CLI y pruebas existentes. Mejorar el diagnóstico de recepción recordada: distinguir el ajuste bruto del chat, el permiso por carpeta y la recepción efectiva desconocida de Claude. No abrir ni crear estado como efecto secundario de `doctor`. Detectar receptores sin capacidades actuales y explicar que actualizar archivos no recarga automáticamente un proceso vivo.
2. **Reconciliación del panel.** Mostrar desde el API que una notificación `unknown` fue consumida cuando el historial nativo contiene su `clientId` exacto. Conservar `unknown` si no existe evidencia, si cambió el proyecto o no se puede consultar la app. No marcar la aplicación de la orden como completada por consumir su notificación. Un proceso interrumpido durante aplicación sigue `application_uncertain`. No repetir wakes al recargar la página o el servicio.
3. **Ciclo de distribución.** Extender el verificador opt-in con el CLI real en un `CODEX_HOME` aislado: instalar la distribución anterior, actualizar al checkout actual, verificar hashes, arrancar con PATH reducido, desinstalar y reinstalar. Sembrar estado privado representativo y comprobar conservación de historial, órdenes y autorización. No copiar autenticación real ni cambiar confianza de hooks.
4. **Cobertura de entorno.** Añadir regresiones para espacios y caracteres especiales en directorios, varios chats con alias iguales, aislamiento de carpetas/worktrees, credenciales del panel tras reiniciar y cierre de conexiones. Reutilizar las pruebas existentes de límites, pausa, cancelación, contexto, barrera, leases, entrega incierta y receptores concurrentes.
5. **Evidencia compartible.** Crear un informe por lista permitida de campos: versiones, nombres de comprobaciones y resultados numéricos/booleanos. No copiar texto libre del modelo, rutas, títulos, UUIDs, sockets, tokens o configuración al informe público. Los transcriptos completos siguen privados.
6. **Pruebas con las apps.** Usar la skill del puente y los chats de prueba ya autorizados. Verificar descubrimiento y estado antes de enviar. Congelar el checkout durante cada colaboración. Probar investigación/revisión y continuación con análisis previos; exigir evidencia correlacionada, conservar desacuerdos. Desde la UI, comprobar participantes, autorización existente, historial y diagnóstico, y reiniciar el servicio sin duplicar acciones. Registrar las limitaciones de cierre/reapertura de apps si el entorno no permite completarlo en este turno.
7. **Distribución candidata.** Preparar versión 0.7.0, notas de cambios, compatibilidad y guía de recuperación/desinstalación. Construir backend y UI; comprobar fuentes y bundles por separado, tipos y verificador real. Instalar localmente solo después de pasar las comprobaciones; no fingir que el MCP de un chat ya abierto cambió de versión.

## Pruebas y evidencia

Comandos desde `plugins/claude-uds-bridge`:

```sh
bun run check
cd ui && bunx tsc --noEmit
# volver a la carpeta del plugin
bun run build
bun test
UDS_MCP_TEST_ENTRYPOINT="$PWD/dist/server.js" UDS_HOOK_TEST_ENTRYPOINT="$PWD/dist/hook.js" bun test
bun run verify:installation
```

Guardar logs y evidencia nativa bajo `.local/phase5/` (ignorada por Git). El informe final debe indicar el commit, versión, plataforma, suite fuente/bundle, número de pruebas y comprobaciones CLI reales. Las pruebas sintéticas ejercitan sockets y procesos reales, pero sus fixtures de Desktop no ejecutan modelos.

| Matriz original | Comprobación necesaria |
|---|---|
| L01–L02 | Ida/vuelta real activa/inactiva; entrada exacta una vez, resultado atribuido |
| L03 | Pasado en el ensayo `REAL_P5_TOOL_702`: mismo PID, herramienta de 35,002111 s y exit 0. Segundo mensaje reservado a +29,781409 s y escrito en el socket 4,897702 s antes del fin; ambas respuestas correlacionadas consumidas una vez. Claude lo leyó al devolver Bash; no se afirma lectura instantánea. Los intentos anteriores no acreditan concurrencia. |
| L04–L05 | Continuación existente/existente y mixta; identificar procedencia, sin inventar historial |
| L06 | Identidades exactas con nombres repetidos; entorno aislado + descubrimiento real |
| L07–L08 | Recepción preservada; diferencias de clase y permisos recordados probadas sin aflojar políticas explícitas |
| L09–L10 | Pausa/reanudación, cancelación y llegada tardía; no avance ni reactivación |
| L11 | Reinicio de servicio y app separados; historia persistente, bloqueo o recuperación explícitos, ningún reenvío |
| L12–L13 | Investigación y revisión real con referencias y versión fija; respuesta del autor |
| L14–L15 | Contexto versionado, tareas antiguas inválidas, objeciones visibles; ningún consenso certificado |
| L16 | Inicio/control nativo desde UI (evidencia fase 4 + comprobación de regresión) |
| L17–L18 | Instalación/hooks del chat de prueba y attach idempotente; mantener historial y receptor único |

La evidencia previa de fase 4 se puede reutilizar indicando fecha y versión. No declarar todos los ensayos reales pasados por sumar tests automatizados. Tampoco declarar mejora de calidad intelectual sin comparar casos y evidencia adecuados.

## Recuperación y continuidad del trabajo

- Revisar `git status`, rama y esta lista antes de reanudar tras una compactación.
- Consultar estado del run y entradas nativas antes de cualquier envío posterior a una caída.
- No reutilizar un ID de mensaje para reintentar. Un ACK perdido no prueba que no se entregó.
- No borrar bases, locks o registros para hacer pasar una prueba. Diagnosticar dueño/PID/inicio y conservar datos.
- Actualización: los archivos nuevos no sustituyen MCP/receptores ya vivos. Reabrir el chat o recargar de forma supervisada con ausencia de trabajo pendiente.
- Desinstalación: conservar por defecto `plugin-state/claude-uds-bridge`; restaurar/reinstalar permite volver a consultar datos. Borrado de datos es una decisión explícita diferente.
- Cambios durante un run: no editar ni hacer commit en el checkout congelado hasta cerrar ese run.

## Estado de ejecución

- [x] Base y rama verificadas; alcance de fase 5 revisado.
- [x] Diagnóstico actualizado y regresiones.
- [x] Reconciliación automática solo por evidencia nativa.
- [x] Ciclo instalación/actualización/desinstalación/reinstalación real.
- [x] Entornos aislados con espacios, alias iguales y worktrees.
- [x] Generador de informe compartible por lista permitida y regresión.
- [x] Tipos, build, pruebas fuente y bundle: 136/136 y 1051 aserciones en cada suite local.
- [x] Ensayos nativos y UI ejecutados; inventario L01–L18 con pendientes explícitos.
- [x] CI de fuente/bundles en Linux y macOS.
- [x] Reapertura completa de apps con MCP y receptor 0.7.0, historial y autorización conservados.
- [x] Casos nativos L06/L17: chats nuevos, homónimos y recepción heredada; repetición válida con formato corregido.
- [ ] Limpieza: Codex temporal archivado; Claude temporal pendiente porque el Mac está bloqueado.
- [x] Notas del piloto y guía de recuperación en PILOTO.md.
- [x] Instalación local 0.7.0 y recarga supervisada de receptores; políticas y autorización preservadas.

Al finalizar, añadir resultados observados, fallos corregidos y limitaciones concretas. Una casilla pendiente no se convierte en aprobada porque otra prueba parecida haya pasado.

## Punto de continuidad (2026-10-04, sesión nocturna local)

Implementación 0.7.0 construida e instalada. Suites finales locales: 135 pass, 0 fail, 1035 expect() tanto fuente como bundle; tipos backend/UI pasan. Verificador CLI real pasa siete comprobaciones, conserva cuatro bases privadas y no copia autenticación. Evidencia en `.local/phase5/`; no añadirla a Git.

Investigación real `REAL_P5_RESEARCH_701` completada con seis mensajes (tres preguntas/respuestas), inicio mixto, análisis de código de Claude, ocho tests ejecutados por él y revisión exacta con matices conservados. No certifica consenso. Después se corrigieron queued huérfano, diagnóstico ambiguo, errores de inspección no visibles, lectura conjunta de proyecto/historia y cobertura de rotación/proyecto cambiado. Su revisión es del borrador previo, no una auditoría de los arreglos posteriores.

Panel CLI reiniciado de verdad: aviso visible de servicio detenido, credencial nueva, historial/ordenes persistentes. Nuevo servicio en `.local/phase5/panel-restarted.jsonl`, sesión de exec 71374. No publicar el token. Receptores de los dos chats de este proyecto son 0.7.0 y mantienen `accept` (propietario) y `default` (prueba), autorización de carpeta revision 1. MCP de chats ya abiertos puede seguir antiguo: no confundirlo con la versión del receptor.

El ensayo final `REAL_P5_IDLE_701` desde el panel despertó el chat nativo inactivo, recibió la revisión exacta de Claude y terminó con dos mensajes. Orden consumida una vez, respuesta consumida, ninguna reserva pendiente y seis órdenes anteriores conservadas. Receptor 0.7.0; política `default`, autorización de carpeta revisión 1 y ajustes de Claude idénticos a la línea base privada de este turno. Cierre `validatedConsensus:false`. Evidencia privada: `idle-real-evidence.json` y `idle-real-export.json`.

CI Linux/macOS aprobada sobre `0e1b6d6`: [ejecución 37251746068](https://github.com/jaimebernalm/cc-cdx-bridge/actions/runs/37251746068). Se publica la rama para ejecutar CI; no se abrió PR ni se fusionó/publicó una release de fase 5. Los ajustes finales de UI (cierre sin resultado y objetivo largo desplegable) y su bundle también pasaron CI Linux/macOS sobre `7581383`: [ejecución 37252604058](https://github.com/jaimebernalm/cc-cdx-bridge/actions/runs/37252604058). El cache instalado coincide con los seis archivos backend/UI del checkout final.

## Inventario final de ensayos reales

Esta tabla distingue pruebas con modelos Desktop de fixtures. «Pendiente» no equivale a un fallo de la suite automatizada. El resumen [PILOT_EVIDENCE.json](PILOT_EVIDENCE.json) omite rutas, identidades, texto libre y credenciales.

| Caso | Evidencia de esta fase y límite |
|---|---|
| L01 | Pasado: investigación/revisión con el chat propietario activo; seis mensajes correlacionados, consumidos. |
| L02 | Pasado: chat Codex inactivo despertado desde UI, dos mensajes y cierre. |
| L03 | Pasado en el ensayo `REAL_P5_TOOL_702`: mismo PID, herramienta de 35,002111 s y exit 0. Segundo mensaje reservado a +29,781409 s y escrito en el socket 4,897702 s antes del fin; ambas respuestas correlacionadas consumidas una vez. Claude lo leyó al devolver Bash; no se afirma lectura instantánea. Los intentos anteriores no acreditan concurrencia. |
| L04 | Pasado con 0.7.0 tras reapertura: existing/existing desde la UI con resúmenes reales atribuidos; Claude confirmó su fidelidad y continuó sin repetir investigación. No hay importación automática de historia. |
| L05 | Pasado: inicio mixto con análisis previo de Codex y análisis nuevo de Claude, procedencia explícita. |
| L06 | Pasado en Desktop: dos Claude del mismo nombre/carpeta se distinguen por sufijo único en la UI. El nuevo recibió y respondió al run correcto; las filas del Claude anterior permanecen idénticas a la línea base. |
| L07 | Pasado: chat `default` usa autorización existente sin cambio de políticas ni ajustes durante el ensayo. La comparación de Claude es contra la línea base de este turno, no contra toda la historia del proyecto. |
| L08 | Fixtures prueban prioridad de política explícita y bloqueo. Los ensayos nativos de retención/denegación son históricos de fase 4; no se cambiaron los permisos reales para repetirlos ahora. |
| L09 | Pasado nativo 0.7.0 desde UI: pausa aplicada, envío rechazado sin admisión ni consumo de presupuesto, reanudación aplicada y nueva respuesta válida. No se interrumpieron herramientas; no había ninguna en ejecución en este ensayo. |
| L10 | Pasado en el ensayo nativo `REAL_P5_LATE_703`: proceso Python vivo descendiente de Claude observado antes de cancelar. La respuesta posterior queda `late`/`dropped`, sin input nativo ni informe materializado; el run sigue cancelado. |
| L11 | Pasado tras reapertura humana de ambas apps: MCP y receptor Codex 0.7.0; procesos Codex/Claude nuevos, mismo chat/proyecto. Historial de runs, seis órdenes previas y entradas nativas L03 conservados; autorización revisión 1 y políticas intactas. Nuevo round-trip desde panel con cuatro controles únicos y una respuesta consumida una vez. |
| L12 | Pasado: investigación de código, contraste, ejecución de ocho tests por Claude y resultado revisado. No prueba mejora de calidad frente a un agente solo. |
| L13 | Pasado: revisión de versión exacta, matices visibles, cierre del autor con desacuerdos; arreglos posteriores respaldados por regresiones. La revisión no audita esos arreglos posteriores. |
| L14 | Pasado nativo 0.7.0: una instrucción desde UI creó contexto 2, tarea local de contexto 1 quedó stale y su informe fue rechazado tras reanudar. La respuesta de Claude pertenece a contexto 2. Los casos de respuesta tardía de contexto antiguo siguen respaldados por fixtures. |
| L15 | Pasado: cierre útil con objeciones explícitas y `validatedConsensus:false`. |
| L16 | Pasado: inicio desde panel en conversación Desktop original inactiva, sin sustituirla por un modelo CLI. |
| L17 | Pasado: instalación real aislada y chat Desktop nuevo con receptor/MCP 0.7.0 desde inicio, sin attach manual. Política default y grant revisión 1; orden y respuesta nativas consumidas una vez. Se verificó la guía corregida en el wire del MCP nuevo. La presencia del receptor no certifica por sí sola la confianza del hook. |
| L18 | Pasado: reactivación supervisada de los chats existentes, receptor único y conservación de historial/política; ensayo final sin duplicados. |

## Punto de continuidad tras reapertura (4 de octubre, noche local)

El usuario confirmó la reapertura de las apps. El MCP que antes estaba ligado al cache antiguo ahora confirma `distribution:ok`, receptor 0.7.0 y autorización recordada. No se reinstaló ni se cambiaron permisos para conseguirlo. El chat Claude existente estaba inactivo; se abrió desde su fila exacta en la app y conservó sesión/proyecto/historia. Los dos procesos son nuevos. El diagnóstico no prueba por sí solo recepción por el modelo: la nueva respuesta correlacionada aporta esa evidencia separada.

Ensayo `REAL_P5_REOPEN_704`, iniciado desde el panel nuevo 0.7.0, finalizado con dos mensajes: continuación existing/existing, pausa/reanudación e instrucción de contexto 2. Las cuatro órdenes se aplicaron y aparecen consumidas una vez cada una. El intento de envío pausado se rechazó; la tarea de contexto 1 quedó stale y su informe se rechazó después de reanudar. Claude respondió una vez `29 + 13 = 42`, confirmó el resumen previo y distinguió recuerdo de comprobación actual. Resultado authored por Codex, sin revisión adicional, cierre `validatedConsensus:false`; no quedan reservas ni tareas vigentes pendientes. Evidencia privada: `doctor-reopened-mcp.json`, `reopen-704-evidence.json`, `reopen-704-export.json` y helper `reopen-evidence.ts`.

Se conservaron seis órdenes anteriores, el run L03 finalizado, el run L10 cancelado y las dos entradas nativas consumidas de L03. La autorización sigue enabled/revisión 1, política del propietario accept y del chat de prueba default. Los ajustes de Claude son idénticos a la línea base privada original. Los dos temporales autorizados siguen conservados; no repetir ni borrar el script para este ensayo.

Durante esta comprobación se observó un defecto visual: el aviso de control conservaba «Activando el chat» después de aplicar la orden. Se cambia para derivar su texto del estado actual de la misma orden persistida, sin modificar entrega, controles ni permisos. Regresión visual aislada pasó: pausa, reanudación y cancelación mostraron transición de «Activando» a «Aplicada» para su orden exacta. Fixture detenido y pestaña cerrada. Tipos backend/UI y build UI pasan; bundle instalado coincide con los seis archivos backend/UI finales, panel real recargado. Capturas privadas `ui-notice-applied.png` y `ui-notice-cancelled.png`. No se añadieron mensajes a modelos ni se cambiaron permisos en este fixture.

CI Linux/macOS del arreglo visual final aprobada sobre `9c474c7`: [ejecución 37258885042](https://github.com/jaimebernalm/cc-cdx-bridge/actions/runs/37258885042). Incluye tipos backend/UI, suite fuente y suite bundle; Linux también comprueba bundles comprometidos contra fuente. Cambios posteriores de este checkpoint son solo documentación.

Pendientes y reglas de continuación:

1. El usuario respondió «sí»: autorizó crear un chat temporal de Codex y otro de Claude para L06/L17 y archivarlos después. Ambos ya existen. No crear más chats para resolver este ensayo; usar las identidades exactas de la evidencia privada de continuación.
2. L08 nativo de retención/denegación sigue histórico de fase 4; regresiones automatizadas actuales prueban política explícita. No cambiar permisos reales para repetirlo sin autorización específica.
3. Conservar todos los runs cerrados y sus IDs; no repetir órdenes ni liberar respuestas tardías. Usar IDs nuevos en cualquier nuevo ensayo.
4. Mantener autorización recordada y políticas; no revocar ni borrar bases para pruebas.
5. Actualizar evidencia saneada y registrar CI de cualquier arreglo nuevo. No declarar la matriz completa ni fase 5 cerrada antes de resolver los ensayos pendientes.
6. No se abrió PR ni release de fase 5. La rama sigue `feature/phase-5-pilot-hardening`.


## Continuidad L06/L17 — 5 de octubre de 2026

La autorización humana ya está recibida. El chat nuevo de Codex arrancó con receptor y MCP 0.7.0, política `default` y autorización por carpeta recordada; no se usó attach manual. El chat temporal de Claude se creó en la misma carpeta y se renombró igual que el anterior, conservando el anterior intacto.

La UI original mostraba dos opciones idénticas. Se corrigió el selector: los homónimos del mismo proveedor muestran un prefijo único de su ID, ampliado si colisiona. La comprobación visual mostró dos sufijos distintos y el valor seleccionado correspondía al nuevo Claude. Diagnóstico y autorización usan la misma regla.

El primer ensayo `REAL_P5_NEW_705` creó una orden aplicada y dos mensajes con las identidades nuevas correctas. La respuesta añadió `verdict` a `kind=response`: quedó `unclassified`, denegada, sin entrada al modelo. No demuestra recepción heredada. El intento alcanzó su plazo; se conserva como `limit_reached` y no se reabre ni libera su contenido. La petición de una tarea correctiva llegó después del plazo y no se envió. El chat Codex terminó descargado/interrumpido; no atribuirle un cierre con propuesta.

Se corrigió la causa de orientación: la plantilla indica por separado los campos de respuesta y revisión. Se conserva la validación estricta. La regresión MCP/socket copia la plantilla real de respuesta y comprueba su admisión, autoría y entrega; también rechaza una respuesta con `verdict` y comprueba la guía específica de revisión. Suites posteriores fuente/bundle: 136 pruebas, 0 fallos, 1051 aserciones cada una. Al ejecutar con umask 077 se detectó que el fixture de directorio inseguro no forzaba su modo 0755; se corrigió con chmod explícito y pasó sin tocar permisos reales.

El control de las apps informó que el Mac estaba bloqueado. Hay una petición pendiente para desbloquearlo; no se intenta saltar el bloqueo. La UI del panel en IAB sigue accesible; el archivado nativo de Claude depende de ese desbloqueo.

Pasos siguientes, sin nueva aprobación:

1. Verificar que el Mac está desbloqueado. Reutilizar el panel local y los dos chats temporales; sus IDs y el enlace privado están en `.local/phase5/` y en el registro vivo. No abrir sesiones CLI de modelos.
2. Inspeccionar descubrimiento y políticas. Mantener `default` del chat Codex y grant revisión 1; los nombres no identifican sesiones. El panel actualizado y backend corregido están instalados en cache 0.7.0; un proceso MCP vivo anterior puede necesitar recarga.
3. Crear un ensayo nuevo con IDs nuevos, una tarea breve, máximo cuatro mensajes y diez minutos (el intento anterior no se reintenta). Especificar el esquema response sin verdict y respetar la plantilla. No modificar el checkout durante el run.
4. Comprobar respuesta admitida y consumida exactamente una vez por el nuevo Codex, orden aplicada/consumida una vez, ninguna nueva fila para el Claude antiguo, hash de settings igual a línea base, grant y políticas intactos. Guardar exportación/evidencia privada; no copiar texto denegado al modelo.
5. Cerrar el ensayo, archivar exactamente los dos chats temporales, confirmar limpieza y actualizar L06/L17 solo si estas pruebas pasan. L08 nativo actual sigue distinto de la evidencia histórica.
6. Publicar commit/CI del arreglo y actualizar plan/evidencia saneada. No hay autorización nueva de PR/fusión de fase 5.


## Resultado de la repetición L06/L17

El ensayo nuevo `REAL_P5_NEW_706` se ejecutó con checkout limpio en `0b440699f2bd85ef9da6f9cdb1cb3b9d186554f9`. Reutilizó exactamente los dos chats temporales autorizados; se reabrió el Codex temporal después de quedar archivado, sin crear otro ni cambiar políticas. La nueva instancia MCP usó la orientación corregida, comprobada contra su wire persistido.

Pasó con dos mensajes, un informe Claude válido, resultado Codex v1 y cierre `proposal`/`completed`, `validatedConsensus:false`. La orden del panel y la respuesta entrante tienen una sola entrada consumida cada una en el historial nativo. Este hecho se comprobó aparte del ACK del núcleo, que en el resultado del agente todavía figuraba sin `consumed_at`. No se afirma que el núcleo conociera el consumo en aquel momento.

Recepción `default`, receptor 0.7.0, autorización enabled/revisión 1 y hash de ajustes Claude iguales a la línea base original. El Claude homónimo anterior no recibió nuevas filas y sus filas existentes se mantuvieron byte a byte al serializarlas. Se conservaron seis órdenes antiguas y se liberaron las reservas. La suma 33 + 9 = 42 se verificó; el marcador inicial de Claude es una declaración atribuida sobre su historial, no prueba independiente. El intento 705 fallido sigue separado y terminal.

Evidencia privada: `new-705-before.json`, `new-705-rejected-export.json`, `new-706-evidence.json`, `new-706-export.json`, `new-evidence.ts`, `new-706-selected.png`, `panel-new-706-completed.png`. Los tokens y transcriptos no se publican. La UI muestra resultado final, dos de cuatro mensajes y cero encargos pendientes.

El chat Codex temporal ya está archivado tras completar la prueba y quedar inactivo. El Claude temporal sigue inactivo y pendiente de archivado: el control nativo exige desbloquear el Mac. La pregunta de desbloqueo está pendiente; no es una autorización nueva ni se deben cambiar permisos. Al continuar: abrir solo el Claude con identidad exacta de `new-706-evidence.json`, archivar mediante UI y conservar el Claude original del mismo nombre. No repetir el run ni crear nuevos chats para esa limpieza.

CI del arreglo `0b440699f2bd85ef9da6f9cdb1cb3b9d186554f9`: [37265302282](https://github.com/jaimebernalm/cc-cdx-bridge/actions/runs/37265302282), fuente y bundles aprobados en Linux y macOS; comprobación de bundle contra fuente aprobada en Linux. Suites locales: 136/0 y 1051 aserciones por suite. La rama sigue publicada, sin PR/fusión/release de fase 5.

La matriz actual contiene 17 casos nativos pasados en 0.7.0. L08 de retención/denegación se conserva como evidencia nativa histórica de fase 4 y regresión automatizada actual; no se presenta como ensayo nativo nuevo de 0.7.0. El rechazo del sobre inválido en 705 aporta un negativo adicional, pero no sustituye un ensayo de políticas hold/refuse con un sobre válido. Implementación y ensayos autorizados de fase 5 verificados; el cierre administrativo sigue pendiente de limpiar Claude.
