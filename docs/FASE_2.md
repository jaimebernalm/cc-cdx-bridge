# Fase 2 — Rutinas guiadas desde el chat

## Estado y recuperación

Autorizada el 2026-10-03: planificar e implementar todos los requisitos de fase 2. Implementada e instalada localmente como **0.4.0**, conservando los cambios de fases 0 y 1. Las tres colaboraciones reales de aceptación terminaron y sus reservas quedaron liberadas. La recarga posterior de Codex confirmó la skill y las diez herramientas gestionadas; una cuarta prueba breve realizada directamente con esas herramientas terminó correctamente. Entrega agrupada en la rama `feature/phase-2-guided-routines` para el PR de fases 0–2. No se han creado chats. Este archivo permite recuperar decisiones, evidencias y pendientes después de un cambio de contexto.

## Objetivo y criterio de diseño

Desde una instrucción en Codex, elegir la conversación Claude Desktop exacta, compartir el objetivo y colaborar con libertad dentro del presupuesto. `free` es el modo por defecto. `research` orienta hacia evidencia, alternativas e incertidumbre; `review` hacia defectos, consecuencias y comprobaciones. Son orientaciones, sin turnos obligatorios ni unanimidad forzada.

Cada agente puede partir de trabajo `new` o `existing`. La combinación produce inicio nuevo, existente o mixto. Un análisis existente se aporta como texto explícito en `context.priorAnalysis`; no se importa el historial de las apps ni se inventa su contenido. Si falta el texto, pedirlo o pedir al otro agente que lo aporte en una colaboración nueva. Un inicio nuevo no puede recibir inadvertidamente un análisis previo marcado como existente. No se promete independencia: ambos modelos pueden ver el contexto compartido y sus chats ya contienen historial. La barrera técnica pertenece a fase 3.

## Contratos

- Mantener las herramientas gestionadas y el sobre `CC_CDX_RUN_V1` de fase 1.
- Añadir configuración de rutina a la preparación: modo y origen de análisis por participante. Validar la combinación con los textos explícitos disponibles. Congelar esta configuración junto al contexto versión 1.
- Añadir un sobre opcional `CC_CDX_WORK_V1` en el cuerpo: encargo con UUID/intención y referencia de borrador, o respuesta/declaración/resultado/revisión. La prosa permanece libre. El emisor real y el `replyTo` del transporte determinan autoría y vínculo; el JSON no puede declarar otro autor ni permisos.
- Encargos sugeridos: analizar, discutir, sintetizar y revisar. Los agentes pueden elegir el siguiente según las preguntas abiertas. Cada encargo pasa por los límites e idempotencia de fase 1; no crear un segundo canal de envíos.
- Resultados: UUID, versión secuencial por el mismo autor, título, contenido, hash, contexto, fuente y desacuerdos. Una revisión referencia una versión y hash exactos; se conserva aunque una versión nueva la vuelva antigua. Su veredicto es una declaración del agente, no consenso certificado.
- Declaraciones (`analysis`, `perspective`, `needs_input`, `blocked`, `done`) no cambian por sí solas el estado del núcleo. Solo controles y hechos de transporte pueden hacerlo.
- Cierre: resultado/version opcionales, resumen y disposición declarada; no inferir aprobación del otro agente. La exportación incluye orientación, puntos de partida, autoría, versiones, revisiones, desacuerdos y cierre.

## Arquitectura

1. `src/routines.ts`: esquemas Zod, normalización del inicio y guías de orientación, sobre de trabajo y reportes.
2. `src/runs.ts` y `src/routine-ledger.ts`: migración SQLite 1→2 aditiva, conservando registros anteriores; tablas para rutina, encargos y reportes. Autoría derivada del caller o transporte. Idempotencia por ID y hash; resultados inmutables por versión. Mostrar revisiones antiguas como tales.
3. `src/collaboration.ts`: validar rutina durante preparación, exigir receptor con capacidad de fase 2, incorporar orientación/encargo y plantilla de respuesta en el mensaje gestionado. No enviar durante preparación/inicio.
4. `Bridge` y descubrimiento: receptor anuncia `guided_runs_v1` asociado a PID/inicio, sin añadir enums desconocidos al registro Claude. Capturar reportes del otro agente únicamente después de una entrega autorizada; no revelar texto de mensajes retenidos/rechazados mediante estado o exportación.
5. MCP: ampliar preparación y envío; añadir guía de rutinas y registro de resultado/revisión propio; ampliar cierre. Mantener las llamadas anteriores compatibles. Validar entradas estrictas y restringir controles al chat propietario.
6. Skill empaquetada `bridge-collaboration`: selección precisa, recuperación de ejecución abierta, rutas nuevas/existentes/mixtas, adaptación libre, límites, recogida de resultados, revisión con versión y cierre. Referencia breve del API/sobres. Integrarla con `skills: "./skills/"`, sin copiarla globalmente ni alterar permisos.
7. Versión 0.4.0, bundles y comprobador de instalación incluyendo la skill. Instalar en la misma identidad de marketplace. Documentar recarga requerida de herramientas/skill de la app.

## Secuencia y recuperación

- [x] P2.1 Esquemas, modos y normalización de origen de análisis.
- [x] P2.2 Migración, encargos, reportes, autoría/versiones y exportación.
- [x] P2.3 Integración del receptor, entrega autorizada y ocultación de contenido retenido.
- [x] P2.4 Servicio/MCP y cierres identificables.
- [x] P2.5 Skill y empaquetado 0.4.0.
- [x] P2.6 Pruebas de núcleo, sockets/MCP, migración y distribución.
- [x] P2.7 Instalación aislada/local y comprobaciones reales de investigación, revisión y continuidad de análisis.
- [x] P2.8 Documentación final y registro de pendientes operativos.

Antes de pruebas reales, completar cambios rastreados y comprobar que no hay colaboración activa ni mensajes pendientes. Cada ejecución fija la huella del proyecto; no editar archivos rastreados durante ella. Usar las dos conversaciones Desktop ya existentes, solo análisis y revisión de lectura, sin cambios del otro agente. Presupuestos pequeños explícitos; no reenviar resultados inciertos. Guardar registros privados en `.local/phase2/`, sin IDs/socket/nonce personales en documentación pública. Cancelar o cerrar toda ejecución de prueba y comprobar reservas liberadas.

## Validación

Pruebas necesarias: modos opcionales y `free` por defecto; inicio nuevo/existente/mixto y rechazo de texto ausente/incoherente; preparación idempotente con rutina incluida; migración preservando datos versión 1 y rechazo de versiones futuras; emisor falsificado, task/replyTo incorrecto y revisión de resultado inexistente; resultados/versiones de otro autor; revisiones de versiones antiguas; declaraciones que no fuerzan estados del núcleo; contenido retenido/rechazado/tardío inaccesible por estado/exportación y sin reporte materializado; respuestas no estructuradas compatibles; presupuesto/cancelación del camino guiado; recuperación de reportes tras reinicio de MCP; exportación legible; skill validada y empaquetada en instalación real aislada.

Ejecutar tipos, suite de fuente, build y la misma suite con bundles. Ampliar solo ante nuevos cambios o fallos. Validar la skill con `quick_validate.py`; eso valida estructura, no decisiones del modelo. Contrastar además su uso en tres ejemplos reales con la pareja actual: investigación acotada del código, revisión de un borrador y continuación de dos análisis explícitos, conservando desacuerdos y registrando cierre/versiones. No presentar fixtures como modelos reales ni una declaración de acuerdo como prueba matemática de consenso.

## Fuera de alcance

Barrera de análisis independiente, versionado mutable del contexto, supervisor persistente, leases, pausa/reanudación automática, consenso técnico de ambas revisiones y UI pertenecen a las fases siguientes. El flujo de fase 2 lo coordina Codex usando su skill y herramientas; la app debe estar abierta y disponible. El núcleo aplica límites de mensajes/tiempo y no impone una agenda intelectual.

## Resultados y pendientes

### Verificación automática y distribución

| Comprobación | Resultado | Alcance |
| --- | --- | --- |
| Tipos y build | Correctos | Fuente y tres bundles actualizados |
| Suite sobre fuente | 73 pruebas, 597 aserciones, 0 fallos | Incluye 12 pruebas nuevas de fase 2 |
| Suite sobre bundles | 73 pruebas, 597 aserciones, 0 fallos | Misma suite sobre la distribución |
| Skill `quick_validate.py` | Válida | Estructura; no certifica comportamiento del modelo |
| Instalación aislada real | 0.4.0 habilitada, archivos coincidentes | Sin autenticación copiada, mensajes a modelos ni cambios de confianza/Claude |
| Lanzador con PATH reducido | Correcto | Localización de Bun y ejecución del bundle |
| Instalación local | 0.4.0, nueve archivos operativos coincidentes por hash | Manifiesto, bundles, lanzador, MCP, hooks, skill y referencia |
| Receptor de este chat | Capacidades gestionada y guiada, proceso verificado | Recargado con los hooks instalados; sin crear un chat |

La base existente se migró al esquema 2, con copia privada previa. Las pruebas comprueban preservación de ejecuciones antiguas; no se inventan rutinas ni análisis para ellas. La versión de contexto sigue siendo 1. La versión de un resultado es un concepto distinto y puede avanzar sin alterar ese contexto.

### Pruebas con las conversaciones Desktop reales

Se aplicó la skill de colaboración y se usó un cliente MCP 0.4.0 vinculado al chat Codex existente para acceder a las herramientas recién instaladas. Claude respondió desde su conversación Desktop Code del mismo proyecto, mediante su transporte nativo; sus mensajes llegaron a este chat y se registraron con su autor real. No se sustituyó ninguna conversación por un modelo CLI. Durante esas primeras tres pruebas, la app todavía tenía cargado el catálogo de fase 1; la recarga y el uso directo de las herramientas nuevas se verificaron posteriormente, como se describe más abajo.

| Caso | Inicio / orientación | Resultado observado |
| --- | --- | --- |
| Investigación | Nuevo/nuevo, `research` | Análisis de ambos agentes sobre garantías técnicas y libertad del intercambio; síntesis atribuida y cierre. Dos mensajes de transporte |
| Revisión | Existente/nuevo, `review` | Borrador de prueba v1 con cinco afirmaciones incorrectas, revisiones atribuidas que las rechazan, corrección v2 y nuevas revisiones. Cuatro mensajes |
| Continuación | Existente/existente, `free` | Copia explícita de los dos análisis reales anteriores; perspectivas nuevas sin repetir la investigación, propuesta y cierre. Dos mensajes |

La revisión conserva dos versiones y cuatro revisiones, dos propias y dos del otro agente. Las de v1 mantienen su hash y aparecen `current:false`; las de v2 apuntan al hash correcto y aparecen `current:true`. Se preservan doce entradas de desacuerdo, incluidas objeciones históricas y un matiz sobre recepción/consumo. La continuación conserva otra objeción de Claude. Los cierres exponen `validatedConsensus:false`, incluso cuando un veredicto dice `agree`; no se fuerza unanimidad.

Las tres ejecuciones están `completed`, sus exportaciones Markdown/JSON están guardadas y no quedan reservas de esos participantes ni entradas retenidas, pendientes de envío nativo o de resultado incierto. El último mensaje se observó en el contexto de este modelo; en la comprobación final el receptor todavía marcaba una entrada `awaiting_input`. Esa marca de transporte no se presenta como prueba adicional de consumo intelectual ni se borra manualmente.

### Incidencia de recepción y autorización

Un primer intento quedó retenido: el ajuste de usuario Claude antes observado como `accept` aparecía sin configurar. No se pudo atribuir la causa. Se canceló esa ejecución; después de la autorización humana «Restablécelo y continúa las pruebas» se restableció exclusivamente `crossSessionInbound: "accept"`, comprobando que los demás campos de ajustes no cambiaron. La respuesta posterior de esa ejecución cancelada fue descartada y no produjo un reporte del otro agente. Las pruebas positivas usaron ejecuciones e IDs nuevos.

La recepción final conserva Claude global `accept` y `accept` solo en el receptor de este chat Codex. No se modificaron permisos de ejecución/edición. No restaurar el ajuste a ausente: el usuario eligió expresamente restablecerlo, sin pedir una activación temporal en este ensayo.

### Recuperación y siguiente acción

Evidencia privada excluida de Git en `.local/phase2/`: `result.json`, `research.json`/`.md`, `review.json`/`.md`, `existing.json`/`.md`, `research-held.json`/`.md`, logs de suites, instalación, recarga y restablecimiento autorizado. No copiar esos archivos completos a documentación pública: contienen IDs y contenido de las conversaciones. `verify-live.ts` comprueba estados terminales, liberación de reservas, versiones/hash, análisis previos explícitos, recepción y archivos instalados.

Recarga comprobada posteriormente el 2026-10-03: aparecen `collaboration_guide` y `collaboration_report`, junto a las ocho herramientas gestionadas anteriores y la skill `bridge-collaboration`. Descubrimiento verificó el receptor nuevo con ambas capacidades, la misma conversación Claude Desktop y recuperación de las ejecuciones anteriores. Antes de enviar, la cola tenía cero mensajes retenidos y cero entradas pendientes de consumo.

Con las herramientas MCP directamente disponibles en este chat, se consultó la guía, preparó e inició una ejecución de cuatro mensajes/300 segundos, registró un borrador Codex y pidió una revisión de la versión 1 exacta. Claude devolvió una única review atribuida; este modelo recibió su mensaje y comprobó el nonce, el cálculo aritmético y el enlace al UUID/versión/hash solicitados. La ejecución terminó `completed` con dos mensajes y sin consenso certificado. Exportaciones privadas `app-reload.json` y `app-reload.md`; comprobaciones en `app-reload-checks.json`. No se cambiaron ajustes ni permisos. Al cerrar, la cola no tenía mensajes retenidos; la última entrada seguía marcada pendiente de consumo en el transporte durante el turno activo, aunque su contenido ya había llegado a este modelo. No se manipuló esa marca.

La recarga pendiente queda resuelta. Para futuras actualizaciones de herramientas/skill, salir completamente de Codex con **⌘Q**, abrir la app y volver a esta conversación; verificar catálogo, receptor y registro antes de preparar otra ejecución. No reenviar pruebas cerradas. Si el catálogo sigue siendo antiguo, diagnosticar carga del plugin sin cambiar permisos ni crear otro chat.

Después de la recarga, una instrucción como «Colabora con la conversación Claude de este proyecto para contrastar estas propuestas; continuad desde nuestros análisis previos y conservad los desacuerdos» activa el flujo de selección, contexto, encargos, resultados y cierre. El texto previo debe estar disponible explícitamente; no se hereda el historial de la otra app.

### Mejora propuesta por Claude, todavía no implementada

Derivar para cada resultado el estado de revisión (`none`, `other_agent_current`, `other_agent_stale`, `self_only`) a partir de autor, versión y hash; mostrarlo en la exportación y congelarlo como información en el cierre. Hoy esos datos están disponibles como revisiones atribuidas y vigentes/antiguas, pero no existe ese campo agregado ni su instantánea. Permitir autorrevisión no equivale a revisión por el otro participante.

Esta mejora de presentación no exigiría otra revisión ni bloquearía el cierre. Tampoco demostraría rigor, verdad del veredicto o consenso. Si se añade una exigencia de revisión externa, debe ser una elección explícita con una salida incompleta cuando el otro agente no responda; su diseño corresponde a la siguiente fase.
