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
- [x] Tipos, build, pruebas fuente y bundle: 135/135 y 1035 aserciones en cada suite local.
- [x] Ensayos nativos y UI ejecutados; inventario L01–L18 con pendientes explícitos.
- [x] CI de fuente/bundles en Linux y macOS.
- [ ] Reapertura completa de apps con 0.7.0 y casos nativos pendientes de la matriz.
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
| L04 | No repetido con 0.7.0: continuación de dos análisis previos comprobada en fases anteriores. |
| L05 | Pasado: inicio mixto con análisis previo de Codex y análisis nuevo de Claude, procedencia explícita. |
| L06 | Fixtures pasan con alias iguales e identidades exactas. No se crearon dos conversaciones Claude reales con nombres iguales; ensayo nativo pendiente. |
| L07 | Pasado: chat `default` usa autorización existente sin cambio de políticas ni ajustes durante el ensayo. La comparación de Claude es contra la línea base de este turno, no contra toda la historia del proyecto. |
| L08 | Fixtures prueban prioridad de política explícita y bloqueo. Los ensayos nativos de retención/denegación son históricos de fase 4; no se cambiaron los permisos reales para repetirlos ahora. |
| L09 | UI aislada: pausa/reanudación correctas. Evidencia nativa de fase 4 reutilizable como histórica, no atribuida a 0.7.0. |
| L10 | Pasado en el ensayo nativo `REAL_P5_LATE_703`: proceso Python vivo descendiente de Claude observado antes de cancelar. La respuesta posterior queda `late`/`dropped`, sin input nativo ni informe materializado; el run sigue cancelado. |
| L11 | Servicio de panel y receptores reiniciados con historial conservado y sin duplicados. Reinicio completo de ambas apps con 0.7.0 pendiente: Codex ejecuta este turno y otra conversación Claude estaba trabajando. No cerrar las apps automáticamente en esas condiciones. |
| L12 | Pasado: investigación de código, contraste, ejecución de ocho tests por Claude y resultado revisado. No prueba mejora de calidad frente a un agente solo. |
| L13 | Pasado: revisión de versión exacta, matices visibles, cierre del autor con desacuerdos; arreglos posteriores respaldados por regresiones. La revisión no audita esos arreglos posteriores. |
| L14 | UI aislada: contexto 2 y controles correctos; invalidación de tareas antiguas cubierta por tests. Evidencia nativa de contexto 2 pertenece a fase 4, no se repitió ahora. |
| L15 | Pasado: cierre útil con objeciones explícitas y `validatedConsensus:false`. |
| L16 | Pasado: inicio desde panel en conversación Desktop original inactiva, sin sustituirla por un modelo CLI. |
| L17 | CLI real instala/actualiza/desinstala/reinstala en home aislado. Receptores reales recargados con 0.7.0. No se creó un chat Desktop nuevo ni se verificó su nuevo MCP tras reiniciar toda la app; pendiente. |
| L18 | Pasado: reactivación supervisada de los chats existentes, receptor único y conservación de historial/política; ensayo final sin duplicados. |

## Último paso tras la reapertura

1. Dejar terminar cualquier trabajo de Claude y cerrar/reabrir Codex y Claude Desktop; no modificar permisos.
2. Volver a este chat, leer esta sección y el inventario; comprobar distribución cargada, capacidades, proyecto exacto y receptor único.
3. Consultar el ensayo final ya cerrado y sus entradas antes de enviar nada. No reabrir/repetir su orden. Comprobar historia y autorización revisión 1 conservadas.
4. Ejecutar una colaboración nueva y breve desde el panel con el chat de prueba existente; correlacionar respuesta y contar entradas. Registrar por separado MCP y receptor 0.7.0 y marcar L11 solo después de esa evidencia.
5. L03 y L10 ya cuentan con ensayos nativos y evidencia privada de este turno. L06 y L17 necesitan chats temporales; hay una pregunta asíncrona pendiente para autorizarlos. No crear chats hasta recibir respuesta explícita. Repetir después de recargar solo si aparece una diferencia relevante en el nuevo MCP.
6. Actualizar esta tabla y el resumen saneado. No anunciar la matriz completa ni la fase 5 cerradas antes de resolver esos pendientes.

### Estado al entregar el turno (continuación del 4 de octubre)

L03 completado y cerrado con cuatro mensajes. Evidencia privada: `tool-702-evidence.json`, `tool-702-core.json`, `tool-702-observation.json` y export. Solo se sobrescribieron los dos temporales autorizados. L10 completado con cancelación real, respuesta tardía descartada y estado terminal conservado; evidencia privada `late-703-evidence.json`, core/observación/export. Los ajustes de Claude siguen idénticos a la línea base privada original. No quedan runs de prueba activos.

**Antes de continuar, recargar las apps.** El doctor llamado desde el MCP de este chat devuelve `distribution_incomplete`, porque conserva el proceso anterior ligado al cache sustituido. El CLI instalado 0.7.0 comprueba `distribution:ok`, `receiver:ok`, versión de receptor 0.7.0 y autorización vigente. Esto demuestra la diferencia entre instalar archivos y actualizar el MCP vivo; no reconstruir ni reinstalar de nuevo para resolver un proceso antiguo. Evidencia privada: `doctor-current-mcp.json` y `doctor-current-installed.json`. Los ensayos nativos aquí prueban el comportamiento del transporte con receptor 0.7.0 y MCP preexistente; no acreditan que toda la app haya cargado 0.7.0.

Claude ya recibió la autorización humana de los dos temporales y no hay que repetir aquella pregunta. Una respuesta del primer run cerrado se descartó correctamente; el primer seguimiento llegó después de terminar la herramienta y se cerró incompleto. No reutilizar esos runs ni atribuir sus respuestas al ensayo 702.

El panel real 0.7.0 queda abierto. Está pendiente la respuesta a la pregunta de crear y archivar un chat temporal de Codex y otro de Claude para L06/L17. Esa autorización es distinta de la de los dos temporales. Mantener la autorización recordada del proyecto y las políticas de los chats; no cambiarlas durante reapertura.

Tras la reapertura, verificar MCP/distribución/receptor y recuperación de historial, después continuar con el inventario. Todavía no se declara fase 5 cerrada, ni se abrió PR/release de fase 5.
