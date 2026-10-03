# Fase 0: base instalable, diagnóstico y recepción

## Alcance y decisiones

La colaboración libre será el modo inicial del producto. Investigación, revisión y otros usos serán ayudas opcionales; no impondrán una secuencia intelectual. Esta fase construye su base de transporte, no el coordinador ni la UI.

La recepción no se habilita cambiando silenciosamente la configuración global. El diagnóstico debe distinguir lo observado de lo desconocido. Una sesión Claude Desktop no publica en el registro su clase de permisos ni la configuración efectiva de recepción; leer un `accept` en un archivo no demuestra que esa sesión lo aplique.

## Tareas y validación

| Tarea | Implementación | Verificación |
| --- | --- | --- |
| P0.1 Conservar el punto de partida | Instantánea privada de los cambios del smoke test; evidencia pública saneada | Diff y copia local separados de las funciones nuevas |
| P0.2 Identificar el fork | Marketplace `jaimebernalm`, versión del fork y atribución MIT; mantener identidad del transporte/estado | Instalación con Codex CLI en un home aislado |
| P0.3 Resolver Bun desde la app | Lanzador con rutas conocidas, error útil si no está disponible | Arranque con PATH reducido y sin Bun |
| P0.4 Diagnóstico de solo lectura | `doctor` en CLI y MCP: runtime, manifiestos, contrato IPC, proyecto, receptores, superficies y motores Claude | Fixtures y diagnóstico real; no mensajes ni edición de ajustes |
| P0.5 Asociar un chat existente | `attach_current` con ID del caller MCP y validación nativa del proyecto; CLI explícita para pruebas | Repetición, concurrencia, proyecto incorrecto y limpieza |
| P0.6 Precisar recepción | Evaluador de clases/políticas y observaciones de archivos; desconocidos conservadores | Matriz de clases, restricciones y fuentes no observables |
| P0.7 Consolidar distribución | Bundles, versión Bun fijada en CI, pruebas de distribución | Tipos, suite y build reproducible |
| P0.8 Validar instalación y hooks | Instalar la distribución real; revisar confianza desde la app | Separar instalación CLI, MCP, hook y receptor; no afirmar equivalencia |
| P0.9 Decidir uso habitual | Documentar alcance global, ausencia de ajuste por chat Desktop verificado y piloto supervisado | Matriz con evidencia real previa y pruebas actuales etiquetadas |

## Criterios de cierre

- La distribución del fork se instala y ejecuta desde un entorno limpio.
- El diagnóstico informa la causa y el siguiente paso, sin enviar desafíos ni exponer tokens, configuración completa o historial.
- Asociar el mismo chat dos veces reutiliza su receptor; una asociación no borra el historial ni cambia permisos.
- Un contrato IPC desconocido, un proyecto distinto o una selección ambigua impiden afirmar disponibilidad.
- No se automatiza un cambio global temporal de recepción en esta fase. Por tanto, no se crea un nuevo mecanismo que requiera restauración.
- La confianza de hooks y la carga de herramientas en una conversación real se comprueban aparte. Si requieren una acción de la persona, el cierre operativo queda pendiente y se indica expresamente.
- La prueba real anterior acredita una ida y vuelta con autorización temporal restaurada. Las pruebas con fixtures no se etiquetan como ensayos nuevos de las dos apps.

## Resultado y evidencia

Implementación de base terminada el 2026-10-03. La matriz detallada se conserva en [COMPATIBILIDAD.md](COMPATIBILIDAD.md).

Comprobaciones ejecutadas:

- `bun install --frozen-lockfile --ignore-scripts`: dependencias reproducibles, sin cambios del lockfile.
- `bun run check`: tipos correctos, incluyendo scripts y pruebas.
- `bun test`: 49 pruebas, 413 aserciones, ninguna fallida.
- La misma suite con `UDS_MCP_TEST_ENTRYPOINT` y `UDS_HOOK_TEST_ENTRYPOINT` apuntando a `dist/`: 49 pruebas, 413 aserciones, ninguna fallida.
- Cinco repeticiones de las pruebas de fase 0 después de corregir la contención de SQLite: 30 pruebas, ninguna fallida.
- `bun run build`: bundles de servidor, hook y CLI generados. La suite de activación se volvió a ejecutar tras el último ajuste del lock.
- `bun run verify:installation`: marketplace e instalación desde cero en un home Codex aislado, archivos cacheados idénticos al checkout y lanzador funcional con `PATH=/usr/bin:/bin`.
- Instalación real: `claude-uds-bridge@jaimebernalm`, versión 0.2.0, habilitado por Codex CLI. No se cambió la base de confianza de hooks.
- Diagnóstico real del chat existente: proyecto y stream 11 correctos, motor Claude Desktop 2.1.286 identificado. Antes de activar: `needs_receiver`. Después: `policy_unknown`.
- Activación explícita real dos veces: la primera creó el receptor; la segunda lo reutilizó. En esa comprobación no se enviaron mensajes ni se modificaron ajustes Claude.
- Tras la aceptación humana de los hooks, un chat temporal autorizado arrancó su receptor automáticamente, sin `attach_current` ni llamadas manuales a los hooks. Se comprobaron registro, socket y proyecto. Al archivarlo se retiraron registro y socket; SQLite quedó sin receptor y con ciclo de vida inactivo. Esta conversación permaneció activa.
- Ensayo nuevo con la recepción actual: se envió un solo reto mediante el MCP real. Claude devolvió `held` y después `expired`, sin respuesta del modelo. No se cambiaron ajustes ni se reenvió el reto.
- Corrección descubierta durante ese ensayo: los mensajes salientes retenidos por el destinatario ya no entran en la cola de aprobaciones entrantes de Codex. Aprobar, denegar o cambiar la caducidad/política local no puede liberarlos, inyectarlos en Codex ni enviar recibos falsos al destinatario. Una prueba de regresión cubre estas acciones.
- Distribución local actualizada después de la corrección: los seis archivos de runtime/configuración cacheados coinciden con el checkout; los dos hooks conservan su confianza. La instalación aislada se volvió a verificar. Reemplazar los bundles en disco no demuestra que los procesos que ya estaban cargados se hayan reiniciado con ese código; la corrección estará activa en ellos tras recargar el plugin o abrir el siguiente chat.

Los reportes privados quedan en `.local/phase0/` y no se publican. La instantánea anterior a las funciones nuevas está en `.local/phase0/baseline/`.

## Cierre del ciclo de vida y límites operativos

La aceptación de hooks, la carga de herramientas MCP, el arranque automático de un chat nuevo y la retirada al archivarlo están comprobados en la app real. La prueba fue autorizada expresamente y el chat temporal quedó archivado. No comprueba todos los casos de reanudación, desconexión o reinicio de la app.

Según la [documentación de hooks](https://learn.chatgpt.com/docs/hooks), SessionEnd se ejecuta al archivar/eliminar la conversación abierta, al cerrar normalmente Codex o tras el plazo de inactividad sin clientes; cambiar de conversación no lo dispara inmediatamente. La prueba realizada acredita el caso de archivo.

Quedan dos límites explícitos:

1. La ausencia de Bun en un chat ordinario del host real sigue sin ensayarse. El lanzador con PATH reducido y el error sin runtime están probados; quitar Bun del sistema del usuario no forma parte de esta entrega.
2. La recepción habitual de esta pareja no permite completar el intercambio. Antes de colaboración desatendida habrá que elegir una configuración aceptable para las sesiones concretas y repetir una prueba bajo esa configuración. La autorización temporal anterior no se reutiliza.

La fase 0 entrega la base y cierra la comprobación real del ciclo de hooks en el caso probado. El producto permanece como piloto supervisado; no se declara disponible la colaboración automática con los ajustes actuales de esta pareja. No se ha implementado la fase 1.
