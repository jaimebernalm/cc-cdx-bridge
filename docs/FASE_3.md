# Fase 3 — Estado estructurado, barrera y recuperación

## Punto de recuperación

Rama: `feature/phase-3-structured-recovery`, creada desde `ab3365d` (PR de fases 0–2 fusionada). El usuario ha autorizado analizar, planificar, implementar y probar esta fase. El usuario ha autorizado ahora preparar y publicar la PR y resolver conflictos con main; la fusión de esta fase queda pendiente de una instrucción posterior. No modificar ajustes de recepción ni permisos. Las conversaciones reales se seleccionan por ID/proceso verificado, nunca por nombre ni mediante sustitución por CLI.

Estado: fase 3 implementada y verificada. Fuentes, bundles, instalación, skill y prueba real final completados. Receptor 0.5.0 recargado; catálogo nativo pendiente de recarga de la app. Preparación de PR autorizada; revisar la integración con origin/main antes de publicarla. Actualizar este apartado tras cada bloque verificable. Los archivos `.local/` son evidencia privada y quedan fuera de Git.

## Diagnóstico y decisiones

La fase 2 ya tiene sobres correlacionados, límites, resultados inmutables y revisiones de versión. Sus límites reales son: contexto fijo en 1; tareas sin ciclo de vida; captura de respuestas después de inyección; `unknown` sin reconciliación con el historial nativo; bloqueo sin reanudación; falta de lease y de cobertura de revisión derivada. No hay supervisor que genere trabajo intelectual automáticamente.

La fase 3 añadirá coordinación estructurada opcional (`coordination` al preparar), manteniendo compatibles las llamadas anteriores. La barrera es opt-in y solo admite comienzos new/new sin análisis aportados. Retiene el contenido recibido y autorizado hasta que ambos hayan registrado un análisis inicial. No borra memoria previa de las conversaciones: garantiza orden de intercambio de esta ejecución, no independencia intelectual absoluta.

El receptor seguirá observando transporte y liberando entradas ya autorizadas. No generará encargos nuevos, no asumirá permisos y no reenviará entregas inciertas. El agente propietario elige preguntas y fases; el núcleo automatiza validación, apertura de barrera, invalidación de contexto, reconciliación y detección de recuperación pendiente. La UI corresponde a fase 4.

## Contratos

### Persistencia y compatibilidad

- Plugin 0.5.0; esquema SQLite 3, migración aditiva transaccional desde 1/2. Rechazar esquemas futuros sin tocarlos.
- Tablas auxiliares de control, historial de contexto, metadatos de mensajes/informes y tareas. Mantener tablas anteriores y datos históricos.
- `CC_CDX_RUN_V1` conserva prefijo y acepta `contextVersion` entero positivo. El propietario crea la versión; el par solo responde con la recibida.
- Las ejecuciones sin `coordination` conservan el comportamiento anterior, con mejoras de observación y exportación.

### Control y lease

- Estados: prepared, active, paused, blocked, recovery_required y estados terminales existentes.
- Fases elegibles: context, independent_analysis, critique, verification, synthesis, final_review. No secuencia universal obligatoria.
- Control por comando UUID, contenido idéntico idempotente, `expectedRevision` como compare-and-swap. Registrar actor, revisión anterior/nueva y cambio completo en una transacción inmediata.
- Lease por instancia de controlador, con vencimiento configurable y fencing: una instancia distinta no envía ni declara informes; no se puede robar un lease vigente. Vencimiento deja recuperación pendiente, sin liberar las conversaciones hacia otra ejecución.
- Recuperación explícita revalida participantes/proyecto; no reenvía. Si hay intentos reservados/submitting/unknown, mantener recovery_required hasta evidencia exacta o cancelación. No ofrecer deduplicación imposible de garantizar en Claude.
- Pausa conserva plazo y presupuesto. Recibe y registra respuestas autorizadas pero retiene la inyección y no lanza encargos. Reanudar solo con lease vigente, participantes iguales y sin incertidumbre de envío.
- Cambio de contexto crea versión inmutable nueva, invalida tareas abiertas y reinicia barrera. No permite reetiquetar informes históricos. Fase/cambio de contexto no son permisos.

### Encargos y respuestas

- Tareas ligadas al autor esperado, contexto y fase de creación; una respuesta válida por tarea. Una tarea local permite registrar el análisis de Codex para la barrera.
- Validar taskId, replyTo, autor, versión contextual y objetivo exacto de review. Un duplicado no incrementa presupuesto ni crea otro encargo.
- Mensaje sin sobre estructurado/malformado queda como no clasificado, nunca completa tarea ni abre barrera; durante barrera no se muestra al modelo.
- Respuestas antiguas/tardías quedan registradas y ocultas, sin validar contexto nuevo. Todo contenido retenido por permisos sigue oculto en status/export.

### Barrera de análisis inicial

1. Preparar coordinación con `initialBarrier:true`, contexto new/new, iniciar y adquirir lease.
2. Declarar tarea local analyze para Codex y enviar analyze a Claude. Ambos son de fase independent_analysis.
3. Claude responde. Tras comprobar permiso de recepción, el núcleo registra el informe en privado; antes de entregar al modelo decide buffer.
4. Codex registra su informe local de análisis para su tarea. No se permiten preguntas/resultados de otro propósito detrás de la barrera.
5. Cuando hay dos respuestas iniciales válidas del contexto actual, abrir barrera automáticamente. El receptor libera la respuesta Claude una sola vez. No enviar el análisis Codex a Claude antes de esa apertura.
6. Export/status nunca exponen el análisis Claude antes de la apertura, ni por campos alternativos de informes/eventos. Los hashes y metadatos sí pueden observarse.

### Evidencia y revisiones

- Separar recepción de transporte, inyección/ACK nativo, consumo observado en historial y respuesta correlacionada. Ninguno certifica calidad intelectual.
- Antes de IPC guardar el ID cliente nativo. Una lectura exacta del historial reconcilia `unknown` a consumed sin segundo envío. Una respuesta validada de Claude acredita respuesta a la tarea, sin inventar un ACK perdido.
- Resultados e informes guardan su contexto real. Review vigente exige mismo resultId, versión, hash y contexto actual; cobertura por autores deriva de filas, no del texto final.
- Exponer none/self_only/other_agent_current/other_agent_stale y reviewedByBoth. Ambas revisiones pueden declarar desacuerdos: cobertura no significa consenso.
- Cierre congela cobertura y desacuerdos del resultado. Cierre por plazo/presupuesto conserva exportación parcial y tareas pendientes sin llamada extra al modelo.

## Orden de implementación

1. [x] Añadir módulo de coordinación/esquemas, migración y metadatos contextuales.
2. [x] Integrar controles, fencing, tareas locales, contexto y ciclo de respuesta en RunStore.
3. [x] Integrar gate de barrera/pausa tras permiso y antes de IPC; liberación persistente y reconciliación nativa.
4. [x] Publicar herramientas MCP/control y capacidad structured_runs_v1; revalidación de procesos en recuperación.
5. [x] Derivar revisión/contexto/cierre y exportación completa con redacción.
6. [x] Actualizar versión, documentación, skill y referencia API.
7. [x] Pruebas deterministas de fallos y carreras, suite existente, TypeScript, bundles reproducibles e instalación aislada.
8. [x] Prueba real acotada en las conversaciones seleccionadas, o documentar impedimento concreto sin sustituirla por una simulación.

## Matriz de aceptación

- Análisis Claude primero: ningún texto visible ni inyección antes del informe Codex; permisos hold/refuse no abren barrera.
- Repetición del mismo mensaje e informe: una fila/contador; segundo mensaje para la misma tarea no completa dos veces.
- Cambio a contexto 2: respuesta de contexto 1 visible como stale en metadatos y sin aprobación del resultado actual.
- Pausa/resume: guardar respuesta durante pausa y entregar una vez al reanudar; presupuesto/plazo no se reinician.
- Dos controladores: lease vigente y revisión CAS impiden dobles mutaciones; lease vencido queda recovery_required; recuperación no reenvía unknown.
- Caída entre intención/IPC/ACK: ID nativo persistido; consumo exacto reconcilia sin inyección repetida; sin evidencia permanece recuperación pendiente.
- Respuesta Claude con ACK ausente: respuesta y ACK siguen campos separados.
- Revisión de otro hash/contexto/version o autor falso: no cobertura actual. Dos revisiones de la versión exacta sí cobertura, nunca consenso automático.
- Exportación parcial al límite conserva pendientes y desacuerdos; contenido no autorizado o detrás de barrera no se filtra.
- Migración 1/2 y rechazo futuro; source y dist ejecutan mismas pruebas; build repetida no cambia dist.

## Comandos de verificación y recuperación del desarrollo

Desde `plugins/claude-uds-bridge`: `bun run check`, `bun test`, `bun run build`, `UDS_MCP_TEST_ENTRYPOINT="$PWD/dist/server.js" UDS_HOOK_TEST_ENTRYPOINT="$PWD/dist/hook.js" bun test`, `bun run verify:installation`. Desde raíz: `git diff --check`, `git status --short --branch`. No ejecutar pruebas reales durante compilación/edición que cambie el fingerprint del proyecto: terminar cambios primero, luego preparar nueva ejecución.

Antes de tocar receptor instalado: identificar PID/inicio y conversación, comprobar cero claims activos/pendientes inciertos, guardar backup privado y usar hooks existentes. Nunca matar un proceso por PID sin comparar inicio. No copiar bases privadas a Git. Si catálogo de herramientas de la app sigue en 0.4.0, registrar que requiere recarga; un helper MCP local sirve para validar el contrato pero no prueba que la UI haya recargado el catálogo.

## Evidencia final

Prueba real completada mediante la skill del puente y un cliente MCP 0.5.0 asociado a este mismo chat, usando la conversación Claude Desktop previamente elegida. No se creó otro chat ni se cambiaron ajustes. Claude respondió primero: el informe se registró en privado, la barrera permaneció cerrada y ni status ni el contexto Codex contenían su análisis. Codex registró su análisis y el receptor entregó la respuesta nativa; se verificó el nonce solicitado. Pausa y reanudación conservaron plazo/presupuesto; cierre completed con dos mensajes y dos informes, reservas liberadas. Se repitió la prueba con el código definitivo, incluido el ledger privado separado y la protección de escritores antiguos, obteniendo el mismo resultado. Evidencia privada en `.local/phase3/live-final.json`, `.md` y `final-checks.json`.

La revisión final añadió una protección específica de actualización: las conexiones 0.5.0 declaran una capacidad local TEMP en SQLite y los triggers rechazan escrituras de un proceso antiguo todavía abierto sobre ejecuciones estructuradas. Los análisis iniciales del par se guardan en `barrier_reports`, fuera del ledger legado, hasta abrir la barrera: una lectura del catálogo antiguo tampoco revela el informe anticipado. El marcador distingue versiones compatibles; no pretende aislar un usuario malicioso con acceso al mismo archivo SQLite.

Pruebas deterministas + MCP/UDS/IPC: recuperación de controlador muerto antes de vencer lease; segundo controlador; ACK perdido con historial exacto; respuesta Claude sin ACK; pausa y versión antigua; duplicados; presupuesto/plazo; cobertura de revisión y cierre. La prueba de fallo no mata aplicaciones reales: usa procesos MCP y el contrato IPC en aislamiento.

Límites: no se ha ejecutado CI Linux en esta rama; la prueba real no simula caída de Claude ni borra historiales. La generación intelectual continúa en los turnos de los agentes; no hay motor de tareas LLM en segundo plano ni panel visual. La barrera no garantiza independencia intelectual frente a historia previa, archivos compartidos o texto de análisis incluido manualmente en un prompt. La actualización del catálogo nativo de herramientas de este chat requiere recargar la aplicación; el receptor puede recargarse separadamente con los hooks.


### Verificación final

- TypeScript y lockfile congelado: correctos.
- Suite completa de fuentes: **91 pruebas, 723 comprobaciones**, cero fallos.
- Suite con entradas MCP/hook compiladas: **91 pruebas, 723 comprobaciones**, cero fallos.
- Build repetida: hashes SHA-256 de los tres bundles idénticos.
- Instalación aislada mediante CLI real: 0.5.0, archivos por hash y launcher con PATH reducido correctos.
- Instalación local y receptor final: capacidad structured_runs_v1, mismos hashes que checkout, esquema 3; ajustes Claude conservados.
- Skill validada con quick_validate; enlaces a API y referencia de control estructurado disponibles.
- Prueba real final: dos respuestas/análisis atribuidos, una sola intención de inyección, evento de apertura anterior a esa intención, nonce Claude observado en el chat, pausa/resume y cierre completed, cero reservas de la ejecución.
- `git diff --check`: correcto. Pruebas locales macOS; no se declara CI remota ejecutada.

Para recuperar el trabajo tras compacción: no repetir pruebas reales cerradas. La implementación reside en src/coordination.ts, src/runs.ts, src/routine-ledger.ts y la integración de src/bridge.ts, collaboration.ts y server.ts; pruebas en phase3.test.ts y phase3-native.test.ts. El catálogo de la app ya anuncia la skill 0.5.0. La próxima acción es revisar la PR de esta fase y decidir su fusión o la fase 4, según instrucción nueva del usuario.


### Preparación de PR e integración con main

El usuario autorizó publicar la PR y resolver conflictos. Se integró `origin/main` en `a4627ee` (PR #2, compatibilidad de protocolo) mediante un merge en la rama feature. Se resolvieron diez archivos con conflictos: README, manifests/versiones, comprobación de instalación, doctor, núcleo de ejecuciones, MCP y tres bundles. Se conserva la versión 0.5.0 con la versión centralizada de main; permanecen las correcciones para direcciones UDS codificadas, prioridades, recibos y el bloqueo de conversaciones gestionadas tras /clear. Los bundles se regeneraron desde las fuentes combinadas.

Verificación local después de integrar: TypeScript y lockfile congelado correctos; **109 pruebas y 805 comprobaciones** en fuente y otras **109/805** con MCP/hook compilados, sin fallos. Esta verificación incluye los casos de compatibilidad añadidos en PR #2 y los casos de coordinación de fase 3. La prueba Desktop real documentada arriba se ejecutó antes de esta integración; la combinación final se verificó con MCP, UDS, SQLite y fixture IPC, sin afirmar una nueva prueba real en las apps. La PR de fase 3 no se fusiona automáticamente.
