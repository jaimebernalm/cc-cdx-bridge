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
| L03 | Cola con Claude ocupado: demostrar que su herramienta en curso no se interrumpe; fixture no acredita comportamiento de la app |
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
- [ ] Pruebas nativas y UI; inventario honesto L01–L18.
- [x] Notas del piloto y guía de recuperación en PILOTO.md.
- [x] Instalación local 0.7.0 y recarga supervisada de receptores; políticas y autorización preservadas.

Al finalizar, añadir resultados observados, fallos corregidos y limitaciones concretas. Una casilla pendiente no se convierte en aprobada porque otra prueba parecida haya pasado.

## Punto de continuidad (2026-10-04, sesión nocturna local)

Implementación 0.7.0 construida e instalada. Suites finales locales: 135 pass, 0 fail, 1035 expect() tanto fuente como bundle; tipos backend/UI pasan. Verificador CLI real pasa siete comprobaciones, conserva cuatro bases privadas y no copia autenticación. Evidencia en `.local/phase5/`; no añadirla a Git.

Investigación real `REAL_P5_RESEARCH_701` completada con seis mensajes (tres preguntas/respuestas), inicio mixto, análisis de código de Claude, ocho tests ejecutados por él y revisión exacta con matices conservados. No certifica consenso. Después se corrigieron queued huérfano, diagnóstico ambiguo, errores de inspección no visibles, lectura conjunta de proyecto/historia y cobertura de rotación/proyecto cambiado. Su revisión es del borrador previo, no una auditoría de los arreglos posteriores.

Panel CLI reiniciado de verdad: aviso visible de servicio detenido, credencial nueva, historial/ordenes persistentes. Nuevo servicio en `.local/phase5/panel-restarted.jsonl`, sesión de exec 71374. No publicar el token. Receptores de los dos chats de este proyecto son 0.7.0 y mantienen `accept` (propietario) y `default` (prueba), autorización de carpeta revision 1. MCP de chats ya abiertos puede seguir antiguo: no confundirlo con la versión del receptor.

Pendiente inmediato: prueba final desde panel en el chat nativo inactivo existente, resultado/review y export, comparación de entradas únicas y ajustes; CI nueva Linux/macOS en esta rama; inventario final L01–L18. No cerrar Codex durante el turno. Se observó otra respuesta activa en Claude Desktop, por lo que no se cerró toda esa app. Si el usuario facilita una reapertura al finalizar, validar la distribución completa tras esa reapertura; hasta entonces no atribuir a 0.7.0 un reinicio completo de ambas apps.
