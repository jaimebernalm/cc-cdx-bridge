# Compatibilidad y decisión de recepción — fases 0–2

## Decisión

La distribución actual 0.5.0 se ofrece como **piloto supervisado**. La base de recepción se validó en 0.2.0; la fase 1 añade parejas y registro gestionado; la fase 2 añade skill, orientaciones adaptables y resultados/revisiones atribuidos; la fase 3 añade coordinación estructurada opcional, barrera de intercambio inicial y recuperación explícita. Se prefieren sesiones cuya recepción actual permita el intercambio. No hay una capacidad soportada y verificada para cambiar la recepción únicamente en una conversación Claude Desktop ya abierta. No se introduce un editor automático de configuración global temporal.

En Claude, `/config` escribe la opción de recepción en los ajustes de usuario; `--settings` puede fijarla por proceso al iniciarlo. Ninguna de esas capacidades demuestra un ajuste individual disponible para una conversación Desktop existente. El ajuste de usuario `accept` alcanza otras sesiones Claude. Una restricción de proyecto/local puede endurecerlo; un `accept` de proyecto no permite aflojarlo. Las fuentes managed y del proceso pueden cambiar el resultado efectivo. El registro de sesiones no publica ese resultado.

Fuentes consultadas el 2026-10-03: [mensajería y recepción Claude](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages), [precedencia de ajustes](https://code.claude.com/docs/en/settings#exceptions-to-managed-settings-precedence), [instalación y confianza de plugins Codex](https://learn.chatgpt.com/docs/plugins).

## Qué se puede verificar sin iniciar trabajo del modelo

- Bun y archivos de distribución presentes; manifiesto del fork y versión.
- Propiedad del socket Codex, dueño nativo de la conversación y soporte de entradas externas.
- Contrato del stream versión 11 y carpeta canónica de la conversación.
- Sesiones Claude de esa carpeta, superficie real, versión del motor y PID con tiempo de inicio coincidente.
- Un único receptor Codex y coincidencia con su propietario guardado en SQLite.
- Valores observados de recepción en archivos de usuario, proyecto y local; no son una política efectiva atribuida al chat.

El `doctor` no consulta el historial completo para devolverlo, no emite retos ni registra nuevos receptores. Puede suscribirse brevemente al snapshot nativo de Codex para comprobar el contrato y se desconecta al terminar. Una observación de estado tampoco prueba que el modelo haya consumido un mensaje.

## Matriz de recepción

Las filas con fixtures prueban nuestro evaluador y receptor. No son una nueva medición del proceso interno de Claude Desktop.

| Receptor / remitente | Política efectiva | Resultado | Evidencia |
| --- | --- | --- | --- |
| prompting / prompting | default | Aceptación | Evaluador + receptor con fixtures y protocolo documentado |
| bypass / bypass | default | Aceptación | Evaluador + receptor con fixtures y protocolo documentado |
| prompting / bypass | default | Retención | Evaluador + receptor con fixtures; ensayo anterior real Claude Desktop |
| bypass / prompting | default | Retención | Evaluador + receptor Codex con fixtures; respuesta de la prueba real requirió aprobación específica |
| Cualquier clase | accept efectivo | Aceptación | Evaluador + receptor con fixtures; ida y vuelta real anterior con `accept` de usuario Claude autorizado |
| Cualquier clase | hold/refuse efectivo | Retención/rechazo | Evaluador + receptor con fixtures |
| Clase o fuente no observable | default o desconocida | Desconocido | Doctor conserva `policy_unknown` |
| Usuario accept + proyecto hold/refuse | Restricción más fuerte | Hold/refuse | Precedencia documentada + evaluador; no inferir fuentes efectivas no observadas |
| Default + proyecto accept | No permite aflojar | Default | Precedencia documentada + ensayo real previo fallido |
| Pareja Desktop antes de elegir accept | No observable por completo | Retención y caducidad, sin respuesta | Ensayo real previo: `held` → `expired` |
| Pareja Desktop con accept elegido por el usuario | No inferida solo de los archivos | Respuestas reales entregadas a Codex | Prueba gestionada de fase 1 y tres colaboraciones de fase 2 |

## Entorno medido

| Componente | Versión / contrato | Alcance de la evidencia |
| --- | --- | --- |
| Bun | 1.4.2 | Tipos, suite, build y lanzador |
| Codex CLI | 0.160.0 | Instalación local en home aislado; no equivale a receptor CLI |
| Codex Desktop | 26.930.21537, build 12776; stream 11 | Ida y vuelta previa; activación existente; arranque y archivo automáticos de un chat temporal |
| Claude Desktop Code | Motor 2.1.286 | Registro real; retención previa y colaboraciones completadas con accept autorizado |
| Claude CLI independiente | 2.1.288 | Actualizado previamente; no sustituye el motor Desktop |
| Linux | Contrato POSIX | Suite configurada en CI; no prueba local de las dos apps en Linux |

Una versión de app no es una garantía de compatibilidad futura. La entrega depende de IPC interno. Un stream distinto de 11 se rechaza; no se acepta un esquema por parecido. La versión mínima Claude 2.1.224 identifica disponibilidad de la función, no una certificación de toda versión futura.

## Evidencia real anterior, saneada

La prueba del 2026-10-03 envió un reto aritmético con nonce único desde el chat Codex existente a la sesión local Code de Claude Desktop del mismo proyecto. Claude contestó mediante `SendMessage`. La prueba exigió coincidencia del nonce y resultado, aceptación nativa en Codex y consumo confirmado; las tres comprobaciones pasaron.

Se autorizó expresamente un `accept` temporal en ajustes de usuario Claude y la restauración quedó verificada. Codex liberó únicamente la respuesta concreta del reto. No se cambiaron permisos de ejecución. No se publican aquí IDs privados de chats, sockets, nonces o configuración completa. El artefacto local original permanece excluido de Git.

## Validación de instalación y confianza

La instalación en un home Codex aislado comprueba el selector `claude-uds-bridge@jaimebernalm`, versión 0.2.0 y habilitación del paquete. Los tests MCP comprueban las herramientas y el hook contra un host fixture. Eso no verifica el consentimiento de hooks en la app real.

El usuario revisó y aceptó los dos hooks en Codex. La prueba posterior creó un chat temporal autorizado con una única instrucción de diagnóstico: su receptor apareció automáticamente y las herramientas reales respondieron. Al archivarlo desaparecieron su registro y socket; el receptor SQLite se retiró y el ciclo quedó inactivo. El chat principal siguió activo. No se usó activación explícita en el chat temporal ni se modificó a mano la base de confianza.

El MCP se declara opcional (`required: false`). Los bundles y el lanzador se prueban por separado. Queda una comprobación manual del arranque de un chat ordinario con Bun ausente; no se presenta como comprobada por editar el manifiesto. El arranque automático probado no garantiza todos los órdenes de carga ni los escenarios de reanudación.

## Ensayo con la configuración habitual

La [fase 1](FASE_1.md) exige además un receptor que anuncie `managed_runs_v1`. La inspección real con el MCP 0.3.0 detectó el receptor anterior sin esa capacidad y rechazó la preparación con un diagnóstico de recarga; no envió trabajo a los modelos. Actualizar archivos no reemplaza los procesos ya cargados. Esta comprobación no constituye una nueva ida y vuelta gestionada entre las apps.

Después de activar los hooks se envió un único reto nuevo a la conversación Claude Desktop existente del mismo proyecto mediante el MCP instalado. Claude acusó retención y, tras el plazo de espera, caducidad. No hubo respuesta del modelo. No se cambiaron los ajustes de recepción, los permisos de ejecución ni se reenviaron mensajes.

El resultado acredita transporte y recibos remotos, pero falla la ida y vuelta con la configuración actual. La prueba positiva anterior dependía de una autorización temporal ya restaurada. Antes de uso desatendido se necesita una decisión nueva sobre recepción y una comprobación bajo esa configuración.

El ensayo descubrió que el puente mezclaba mensajes salientes retenidos por el destinatario con la cola local de aprobaciones entrantes. Se corrigieron selección, aprobación, caducidad, capacidad y ciclo de vida para limitar esas acciones a mensajes entrantes. Los recibos remotos siguen visibles en `status`; `inbox` no puede liberar una retención de Claude. La suite de fuente y distribución pasa 49 pruebas con 413 aserciones en cada ejecución. La distribución corregida está instalada localmente; un proceso ya cargado necesita recarga para usar los nuevos bundles.

## Comprobación posterior de fase 1

El 2026-10-03 el usuario eligió recepción `accept` global en Claude y autorizó `accept` únicamente en el receptor del chat Codex participante, conservando los permisos de ejecución y edición. Se recargó el receptor instalado 0.3.0 sin crear chats ni cerrar las apps. Una prueba gestionada nueva de dos mensajes verificó recepción en Claude Desktop, respuesta por `SendMessage` con correlación de ejecución y entrega a la conversación Codex Desktop existente. El agente Codex recibió y comprobó el nonce y el resultado `41 + 67 = 108`. La colaboración quedó cerrada y sus reservas liberadas.

El cliente de prueba usó el MCP local 0.3.0 asociado al chat existente. Las herramientas MCP que la app mantiene en memoria todavía son las anteriores y necesitan recarga antes de gestionar colaboraciones normalmente desde el chat. Esta comprobación acredita una ida y vuelta; no debate prolongado ni funciones de fases posteriores. Los ajustes Claude globales afectan a sus otras sesiones locales; el ajuste Codex se limita a la recepción del puente de este chat. Evidencia privada y detalles en [FASE_1.md](FASE_1.md).

La recarga posterior quedó verificada: las ocho herramientas `collaboration_*` están disponibles en el chat de la app, el receptor tiene capacidad gestionada y mantiene `accept`, no hay entradas retenidas o pendientes, y el registro de la colaboración completada se recupera por `collaboration_status`. No se enviaron mensajes nuevos durante esta comprobación. La necesidad de recarga descrita en el párrafo anterior queda resuelta.

## Comprobación de fase 2

La distribución 0.4.0 añade la skill `bridge-collaboration` y exige un receptor con `guided_runs_v1` además de `managed_runs_v1`. El receptor del chat existente se recargó con los hooks instalados, verificando proceso/proyecto y conservando recepción. La instalación aislada y local comprobaron los archivos por hash, incluida la skill. La suite completa pasó 73 pruebas y 597 aserciones tanto sobre fuente como bundles.

Con un cliente MCP 0.4.0 asociado al mismo chat se completaron tres colaboraciones reales: investigación nueva, revisión de dos versiones con inicio mixto y continuación libre desde ambos análisis anteriores aportados explícitamente. Claude respondió desde Desktop Code; los mensajes llegaron al contexto del agente Codex, conservando autoría, correlación, versiones y desacuerdos. Todas las ejecuciones terminaron y liberaron reservas. Los recibos por sí solos no certifican que un modelo leyera con rigor, y los veredictos no constituyen consenso validado.

Un intento inicial quedó retenido al aparecer el ajuste de usuario Claude sin configurar. Se canceló y, con autorización humana explícita nueva, se restableció únicamente `crossSessionInbound: "accept"`, preservando los demás ajustes. La respuesta tardía de esa ejecución cancelada se descartó. No se modificaron permisos de ejecución/edición ni se crearon chats.

La recarga posterior confirmó `collaboration_guide`, `collaboration_report`, las ocho herramientas gestionadas anteriores y la skill. Una prueba breve realizada directamente con el catálogo de este chat registró un borrador, envió un encargo de revisión y recibió la respuesta nativa Claude de la versión/hash exactos, con nonce y cálculo comprobados por este modelo. Terminó con dos mensajes y liberó las reservas. No se cambiaron ajustes ni permisos. La recarga pendiente de fase 2 queda resuelta. Detalles, evidencia privada, límites y recuperación en [FASE_2.md](FASE_2.md).


## Comprobación de fase 3

La distribución 0.5.0 mantiene el piloto supervisado y requiere `structured_runs_v1` para preparar con `coordination`. Hay contexto versionado, tareas con autor esperado, controles con revisión CAS, lease por proceso, pausa y recuperación. Los informes detrás de barrera quedan en una tabla privada separada hasta abrirse; los procesos antiguos todavía abiertos no pueden escribir ejecuciones estructuradas. Una respuesta correlacionada y un consumo observado se conservan como evidencias separadas del ACK.

Se completó una prueba real de barrera y pausa en las mismas conversaciones Desktop: respuesta Claude anticipada retenida, análisis Codex registrado, respuesta nativa liberada y ejecución cerrada. No se cambiaron ajustes ni se crearon chats. La UI y la generación de encargos intelectuales en segundo plano quedan fuera de esta fase. El catálogo nativo antiguo requiere recarga; la validación MCP nueva se realizó asociada a este chat. Detalles y límites en [FASE_3.md](FASE_3.md).
