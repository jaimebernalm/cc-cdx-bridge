# Plan de inicio bidireccional en Desktop

Propuesta v3 · 2026-10-05 · CC–CDX Bridge. Alcance: planificación; las funciones nuevas se describen como trabajo pendiente.

## 1. Resultado que queremos

Desde Codex Desktop o Claude Code Desktop, el usuario podrá pedir una colaboración, elegir una conversación existente del otro agente o solicitar una nueva y seguir el intercambio en el mismo panel. Podrá continuar análisis anteriores, intervenir, pausar, cancelar, recuperar después de un reinicio y obtener una propuesta con sus objeciones. El panel será inglés por defecto, con español opcional.

Ejemplo: «Colabora con el otro agente en un chat nuevo sobre esta arquitectura. Solo lectura; 20 mensajes y 20 minutos». Consultar capacidades, preparar y abrir panel; comprobar respuesta breve correlacionada antes del análisis grande.

“Nuevo chat” y “análisis nuevo” serán opciones separadas. Actualmente routine.starts describe análisis sin texto previo, no la creación de conversaciones. Una conversación existente puede iniciar un análisis nuevo; una nueva puede recibir una recapitulación atribuida. Ninguna de las dos garantiza independencia intelectual.

La simetría será del flujo y del control, no una afirmación de que ambas apps publican las mismas APIs. Cuando una capacidad no exista, la UI explicará la alternativa disponible.

## 2. Base comprobada y límites de esta planificación

En la rama fix/collaboration-preflight-live-panel, sobre HEAD 6ad513d5eed4fa5355394dbb718339841866313d, hay cambios previos sin commit de recepción, panel en vivo e idiomas, distribución 0.8.1. Deben preservarse. No se mezclará esta ampliación con ellos sin una base revisada. Una futura rama puede llamarse feature/bidirectional-desktop.

Lectura por Codex: server.ts identifica caller Codex; collaboration.ts/runs.ts atan owner Codex y peer Claude; bridge.ts registra receptor Codex; panel.ts/panel-commands.ts usan ownerThread y despiertan Codex; UI infiere dirección por in/out. participants.ts verifica procesos/sockets/proyecto. El grant de project-authorization.ts tiene clave realpath con device/inode. Existe manifiesto Codex, no Claude. El mapa de archivos a modificar está en los hitos del §9.

Claude Opus 5.5 los revisó en un chat nuevo y propuso el núcleo neutral. Corrigió la clave del grant y retiró el nonce como prueba de aprobación humana.

Evidencia real de esta sesión: se creó un chat local nuevo de Claude mediante control de su UI, se observó Opus 5.5 seleccionado y llegó una respuesta correlacionada por el plugin. El modelo también se declaró claude-opus-5-5. Esto no demuestra un API automático de creación ni el funcionamiento del futuro caller Claude. No se ejecutó una implementación nueva ni sus tests.

La documentación oficial permite plugins/MCP/hooks en Claude Code Desktop local. Hay diferencias de carga por scope y precedencia que el piloto debe comprobar. Describe creación desde UI y herramientas entre sesiones; no hemos verificado una API externa del bridge para crear chats locales. [Referencia Desktop](https://code.claude.com/docs/en/desktop).

Los plugins Claude tienen manifiesto .claude-plugin/plugin.json y pueden incluir MCP, skills y hooks. El paquete Codex actual no se convierte automáticamente en uno Claude. [Referencia de plugins](https://code.claude.com/docs/en/plugins).

Los hooks SessionStart reciben información de sesión, carpeta y source; model puede faltar. Un mcp_tool hook se omite en el arranque inicial porque aún no hay contexto MCP: el registro inicial Claude debe investigar un command hook, sin copiar literalmente el hook Codex. [Referencia de hooks](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields).

## 3. Decisiones de arquitectura

1. Mantener un núcleo local compartido, sin preferencia por Codex o Claude. Ambos MCP llaman al mismo contrato y almacenan en el mismo estado privado. No hace falta un servicio remoto, claves API ni sustituir las apps por CLIs.
2. Separar autoridad de conversación, identidad de participante, autorización humana y lease del proceso ejecutor. Poder escribir en stateDir no concede autoridad sobre todas las runs.
3. Cada ejecución tiene un iniciador autenticado. El iniciador y las acciones humanas del panel pueden controlar esa run. El otro participante puede enviar aportaciones propias, leer material autorizado y retirarse; no puede ampliar permisos/límites ni tomar el control mediante un mensaje.
4. El proceso ejecutor puede estar alojado en el MCP de cualquiera de las apps, pero solo entrega con una delegación válida y un lease vigente. Su PID no es el autor intelectual. No introducir inicialmente un daemon permanente: se evaluará si los pilotos muestran que hace falta.
5. Incorporar creación por capacidades: herramienta nativa del host cuando esté disponible y autorizada; automatización UI asistida y probada; alternativa manual transparente. No presentar un enlace, CLI o Agent SDK como un nuevo chat Desktop.
6. El primer hito obligatorio es comprobar identidad/capacidades reales de Claude. Si falla, detener esa vía y registrar el límite antes de migrar estado o prometer simetría completa.

### Modelos conceptuales

```ts
type Provider = 'codex' | 'claude';
type Principal = { provider: Provider; sessionId: string };
type AuthenticatedCaller = {
  principal: Principal;
  nativeProcess: { pid: number; procStart: string };
  projectIdentity: { realpath: string; device: string; inode: string };
  binding: { method: string; generation: string; evidenceVersion: number };
};
type ExecutorLease = {
  runId: string; processId: string; epoch: number; expiresAt: number;
};
type ManagedMessage = {
  runId: string; messageId: string; src: Principal; dst: Principal;
  contextVersion: number; replyTo?: string; bodyHash: string;
};
```

Son esquemas de diseño, no contratos finales. La autoridad y src se derivan del caller verificado; un modelo no podrá escoger su author, PID, aprobación o epoch para ganar autoridad.

## 4. Identidad Claude y transporte

Crear un prototipo aislado antes del uso ordinario. La instalación/hooks y dos chats de prueba deben estar dentro del alcance autorizado por el usuario; reutilizar autorización vigente, consultar si se necesita ampliar ese alcance. Preferir scope/directorio aislado compatible con Desktop; si no existe, registrar exactamente los cambios y su retirada/restauración. Observar solo metadatos de procesos/hooks, sin prompts completos, secretos ni historiales ajenos.

Investigar, en este orden: aislamiento real del servidor stdio por sesión; ascendencia del proceso hasta el motor Desktop registrado; datos que el host envía fuera de los argumentos del modelo; correlación entre command hook de arranque, registro nativo y canal MCP. Verificar PID+procStart, UUID, socket y carpeta canónica. Un session_id recibido como argumento de una herramienta o texto de un hook no basta por sí solo: debe casar con evidencia del canal/proceso. No elegir la sesión más reciente por nombre o carpeta.

Si el host comparte un MCP entre sesiones, no vincularlo a la primera y reutilizarla. Exigir una correlación por llamada verificable o rechazar el modo con caller_ambiguous. Cambios de conversación, compactación, fork, clear, recarga y reinicio invalidarán el binding anterior según generación. Un fork tiene identidad propia y no hereda autoridad de run.

Separar registro nativo Claude de la extensión del bridge. El plugin no escribirá sobre su sessions/<pid>.json, socket o políticas nativas. Si se usa un sidecar, tendrá identidad de transporte propia en el estado privado del bridge, ligada al caller nativo verificado y revocable cuando este termine. El receptor resolverá esa asociación desde evidencia local, no desde un author dentro del texto. No fingir que el PID del MCP es el PID de Claude.

Probar dos alternativas de envío Claude: adaptador sidecar controlado por el núcleo, o reserva durable seguida por SendMessage nativo del agente. Elegir la que permita atribución y control de admisión verificables. La reserva seguida por herramienta nativa necesita reconciliar rechazo, ACK perdido y cierre entre ambos pasos; no marcar delivered porque el agente lo afirme. Si el sidecar es suficiente, preferir una entrega directa desde el adaptador para reducir esos pasos.

La garantía de presupuesto se aplicará al tráfico gestionado admitido por el núcleo. No prometer interceptar toda la mensajería nativa de Claude ni mensajes ajenos al bridge. Determinar en el prototipo si un mensaje no admitido podría llegar al modelo por una vía nativa; documentarlo y no afirmar una barrera global de aislamiento. Las skills son guía; no reemplazan controles del código.

Una llamada desde el MCP Claude no podrá invocar deliverToDesktop directamente para eludir la recepción Codex. Toda entrega pasará por la misma admisión del destinatario: caller/transport binding, run, src/dst, contexto, presupuesto, política de recepción y claim durable. La ruta nativa SendMessage de fallback debe tener el mismo tratamiento; el receptor no concede author por leer from-session como texto. En Claude destino, el adaptador valida antes de enviar al socket nativo y conserva las políticas que aplica el host. No se inventa un hook de ingesta Claude que aún no se ha verificado.

Evidencia por ruta: MCP directo usa el binding del caller/canal validado; sidecar usa su binding privado con el caller nativo; fallback nativo exige coherencia de registro/socket/PID+procStart y una capacidad de respuesta de un solo uso emitida por el núcleo, ligada a run, src esperado, dst, contexto y tarea/replyTo. La capacidad es separada del messageId de idempotencia. No autenticar por la cadena from-session ni por el UUID solo. Medir en S0 si Bun permite credenciales del par UDS en macOS y si estas identifican al motor o a un relay; no asumirlo. Si no hay evidencia suficiente, deshabilitar esa ruta o etiquetar su atribución como local/capability_attributed, sin inventar os_authenticated.

La frontera de confianza sigue siendo el usuario local y sus procesos, registros y estado privado. Un proceso malicioso con el mismo UID puede leer/cambiar estado o robar capacidades; este diseño no lo aísla. Una capacidad filtrada puede permitir suplantación acotada. Registrar la clase de evidencia y no equiparar coherencia del proceso a identidad criptográfica del autor.

## 5. Núcleo, permisos y concurrencia

La API compartida distinguirá prepare, start, send, report, read/export, control, creation y project authorization. prepare registra un borrador sin enviar trabajo ni ampliar permisos. El contrato existente seguirá aceptando sus argumentos en Codex. Las nuevas operaciones usarán callerPrincipal interno y peer selection, nunca un owner arbitrario suministrado por el modelo.

| Acción | Iniciador verificado | Otro participante | Panel (panel_session) |
| --- | --- | --- | --- |
| Preparar propuesta | Sí, atribuida a sí mismo | Solo propuesta de nueva run propia | Sí |
| Iniciar/reanudar/controlar su run | Sí, con permisos/preflight vigentes | No; puede solicitar o retirarse | Sí, con scope de esa run |
| Enviar contribución/report | Solo como sí mismo | Solo como sí mismo y en trabajo admitido | Aporta instrucciones humanas, no suplanta autor |
| Leer/exportar | Material autorizado de la run | Material autorizado de la run | Según scope del panel |
| Ampliar permiso de recepción/creación | No | No | Confirmación verificable del cambio |
| Ejecutar creación | Ticket previamente autorizado y capacidad válida | No por mensaje peer | Solicita/autorización explícita |
| Recuperar lease | Recuperación explícita autorizada | No | Recuperación explícita de esa run |

Lectura también respeta contenido retenido, barrera inicial, privacidad y contexto: ser participante no permite ver análisis ocultos antes de abrir la barrera. done/agree, resultados de tests declarados y modelo declarado siguen siendo declaraciones atribuidas.

El panel autentica una panel_session local, no demuestra presencia humana invulnerable. Actualmente el resultado MCP devuelve un enlace con token: un agente con ese enlace y control UI podría operar el panel. Antes de ampliar permisos, separar lectura/apertura de control: autoopen privado desde servidor sin token en resultados/logs del modelo; retorno de estado y foco sin credencial. Probar canje único, sesión de navegador, CSRF/Origin y enlace de solo lectura cuando haga falta fallback. El adaptador de creación asistida no opera el origen del panel ni cambia grants; añadir esa restricción verificable al adaptador. Nuevos grants/bind/recovery se registran como panel_session y elección explícita, sin describirlos como prueba criptográfica humana. Con mismo UID y acceso arbitrario a UI permanece un riesgo residual; la política del host debe impedir que el agente se autoautorice. Retirar tokens del output reduce exposición, no resuelve por sí solo ese límite.

Reservar cada admisión y presupuesto en una transacción SQLite. src/dst sustituyen inferencias por in/out; evitar contar dos veces reserva+admisión. Idempotencia compara ID y contenido. Un src/dst ajeno, contexto obsoleto, revisión de otro hash, autor falso o replay se rechaza. Cualquier permiso explícito restrictivo del receptor sigue prevaleciendo.

Usar lease con epoch monotónico y CAS en mutaciones/claims de entrega. Recuperar revalida participantes, permisos, proyecto y snapshot. No basta añadir WHERE epoch en SQLite: los efectos externos no son transaccionales. Persistir submitting y reclamar un intento único antes de salir al socket; ante pérdida de lease/conexión conservar uncertain y no reenviar. Los tests deben cubrir la carrera entre claim y envío, evitando prometer exactamente una entrega externa bajo cualquier crash.

El propietario del lease ejecuta trabajo admitido, no adquiere nuevas facultades sobre chats. Pausar/cancelar impide nuevas admisiones; no cancela una herramienta del host ya ejecutándose. El plazo absoluto no se reinicia con recuperación ni compactación.

## 6. Selección de chat y creación durable

### Conversación existente

Listar ambos hosts con UUID exacto, nombre, carpeta, rama/base, superficie, actividad y capacidades. Filtrar el otro proveedor, señalar duplicados y excluir registros muertos/no compatibles. No enviar trabajo para probar una selección. Un chat ocupado se espera o se selecciona explícitamente permitiendo busy. Misma carpeta por defecto; worktrees solo con contrato/base explícitos ya soportados.

### Conversación nueva

Separar creation ticket de run: aún no hay un segundo participante ni reservas de colaboración. El ticket mantiene requestId, requester autenticado, host destino, proyecto/dev/inode, snapshot, modelo solicitado, modo, adaptador, límite, autorización, generación, hostRef y resultado. Un ID devuelto por el modelo es un puntero a comprobar, no prueba de aprobación ni de creación.

Estados orientativos:

```text
requested → authorized → creating → awaiting_receiver → bound
                       ↘ creation_uncertain
requested/authorized/... → expired | cancelled | failed | ambiguous
```

No repetir creating/creation_uncertain automáticamente. Si el host creó el chat pero perdió el ACK, consultar capacidades y estado autorizado; no crear un segundo. Cero candidatos significa espera hasta el TTL, no ambigüedad inmediata. Más de uno exige resolución; nunca escoger por parecido. El ticket tiene un solo consumidor mediante CAS y una asociación final inmutable.

La autorización de recepción actual cubre respuestas gestionadas en la misma carpeta; no cubre creación, bootstrap ni edición. Crear/vincular automáticamente requiere autorización verificable de alcance explícito. Un clic de creación en el panel puede otorgarla para ese ticket. Una solicitud del chat sin evidencia humana observable por el servidor produce un borrador y panel ya rellenado. Para evitar confirmar cada uso, evaluar un permiso separado, opcional y recordable de creación por proyecto/proveedor/modo: el usuario lo confirma una vez en la UI; no se deduce del grant legacy. Si se dispone de un recibo humano autenticado del host, validarlo sin otra pregunta. No asumir que tal recibo exista hoy.

Ese permiso recordable debe precisar acción create/bind, adaptador y modo, con revocación y un tope de tickets concurrentes/frecuencia. Caducidad y valores predeterminados se fijarán en la UI de forma explícita: no se adopta silenciosamente la propuesta de siete días o tres tickets por hora debatida por Claude. Cada ticket aparece en el panel y se puede cancelar. El permiso no concede edición ni un modo más permisivo.

Autovincular exige autorización vigente, binding del receptor independiente, proyecto/snapshot correctos, capacidad compatible y evidencia de creación ligada al ticket desde un adaptador confiable. Ventana temporal+candidato único solo detecta candidatos; no demuestra causalidad. Si la única evidencia disponible es un ID relatado por el agente o el estado visible de la UI, mostrar el candidato y pedir vinculación humana. Modelo/modo no observables se muestran como desconocidos/declarados; no se inventa una comprobación. Si el modelo solicitado no está disponible, informar antes del trabajo, sin sustitución silenciosa.

Hipótesis para S4: un identificador de correlación de un solo uso en el primer prompt, recogido por un command hook del host con sesión/carpeta, puede enlazar ticket y receptor nuevo. Verificar orden de hook, proceso, transcript inicial mínimo y ausencia de turnos previos, sin exportar el historial. Ese identificador no es aprobación y puede ser visible al agente que prepara el prompt; no llamarlo secreto inaccesible al modelo ni usarlo como única autenticación. Si no hay recibo independiente o correlación suficiente, conservar el bind humano. No crear permisos a partir del primer prompt ni aceptar ese recibo en un chat preexistente.

El hook inspecciona solo el patrón de correlación necesario, no guarda/loguea el prompt y termina sin efectos si no hay coincidencia. Verificarlo con un prompt de prueba que contenga datos señuelo.

El primer bootstrap autorizado tiene identidad y contenido fijados, scope de ticket y un intento durable; no lo habilita la recepción managed anterior ni un nonce escrito por un peer. El bootstrap inicial de la herramienta de creación cuenta como un envío: no añadir otro con el mismo contenido. A continuación validar registro, ejecutar preflight y comprobar una respuesta breve dentro del presupuesto de colaboración. Preparar/iniciar la run no envía análisis por sí mismo.

### Adaptadores de creación

| Destino | Situación observada | Camino a implementar |
| --- | --- | --- |
| Codex Desktop | El host de este chat ofrece create_thread al agente; no es una herramienta accesible al servidor del bridge | Adaptador de host condicionado a disponibilidad, autorización explícita y resultado listo; comprobar threadId, no usar clientThreadId pendiente como ID final |
| Claude Desktop local | Esta sesión se abrió mediante UI; no se verificó un API de creación del bridge | Adaptador UI asistido opt-in, con verificación de proyecto/local/modelo; manual como fallback. Investigar API oficial si aparece |
| CLI, SDK, cloud, SSH/WSL | Superficies distintas al objetivo Desktop local | Mostrar incompatibilidad o capacidad separada; no sustituir silenciosamente |

No asumir que Claude disponga de create_thread ni que el MCP invoque tools de otro host. Desde Claude, esta vía requiere un chat Codex vivo con esa herramienta que ejecute un ticket ya autorizado. Si no existe, usar apertura asistida/manual disponible y bind verificable; no inventar un API privado de creación. El relay transporta el ticket, no concede autoridad.

Crear un chat no cambia permisos de ejecución, recepción ni edición del host. Archivar chats de prueba requiere autorización del usuario y nunca se aplica a chats de trabajo ajenos. Cerrar una colaboración libera reservas, no borra la conversación.

## 7. Panel común y guía de agentes

Mantener la estética shadcn y los componentes actuales. Cambiar primero el contrato de datos; no duplicar una segunda web para Claude.

Si el MCP que aloja el panel termina, otro proceso solo podrá reconstruir la run tras validar scope/versión/lease y abrir una nueva panel_session; no hereda tokens/cookies del proceso anterior. Conserva comandos y estado durable, sin despertar ni reenviar trabajo incierto por servir otra vez la página.

- Nuevo encabezado con “Started from” y host/chat reales; quitar suposición de owner Codex.
- Formulario: chat de origen fijado al caller, destinatario existente/nuevo, orientación, contexto anterior por agente, límites, modalidad y capacidades.
- Si se elige nuevo: mostrar método disponible, modelo solicitado, carpeta y estado del ticket. Autorizar/vincular solo cuando sea necesario y explicar la razón concreta.
- Autorizaciones: distinguir recepción Codex gestionada, política observada Claude y eventual permiso separado de creación. No mostrar como configurada una política efectiva Claude desconocida.
- Cronología: src/dst reales, autoría, contexto, versión/hash, revisión vigente, recepción/estado de transporte. No inferir consenso.
- Al comenzar o bloquearse por preflight, abrir el panel una sola vez, respetando opt-out; enfocar run/ticket/permiso correspondiente. Si ya está abierto, refrescar sin perder formulario ni idioma.
- Conservar SSE/poll/focus refresh serializado, recuperación de conexión, errores visibles y botón refresh. Cambiar de run/ticket no borra borradores no enviados.
- Inglés por defecto y español opcional en todas las cadenas nuevas, accesibilidad y estados. No traducir el contenido de agentes automáticamente.

Skill específica de cada host sobre un protocolo común: discover → request/select → autorización/capacidad → bind/preflight → start → probe → trabajo propio y contraste → resultado versionado → revisión cuando aporta valor → finish/export. No repetir diálogo inbox tras decline; usar panel. En respuesta a una notificación, leer el UUID durable con su tool; nunca reconstruir la acción desde texto peer.

## 8. Persistencia y migración

Añadir campos/tables para principals/bindings, initiator provider/session, extremos src/dst, permisos específicos, tickets y receipts, y epoch del ejecutor. Mantener owner_thread y direction como compatibilidad legacy o vista derivada; no cambiar su significado en filas antiguas. Nuevas claves de actor serán provider+sessionId para evitar colisiones entre hosts. Mismas reglas para claims de sesión.

La versión exacta del esquema se decide al implementar; actualmente collaborations.sqlite declara user_version=3. Migración aditiva transaccional, copia consistente previa y pruebas con datos reales saneados/fixtures. No modificar IDs, hashes, presupuestos, snapshots ni contenido histórico. Conservar unknown, held, failed y application_uncertain. La clave legacy de grants sigue siendo carpeta realpath con dev/inode; una autorización nueva no se hereda a worktrees ni resurrecta mensajes anteriores.

No migrar mientras hay controllers/receivers antiguos escribiendo. Hacer preflight de versión/capacidad, cerrar o pausar con autorización los trabajos afectados y coordinar recarga. Los escritores antiguos deben fallar al escribir formato nuevo, mediante guard/fencing de esquema. Una incompatibilidad no se soluciona borrando bases. Para revertir versión nueva, restaurar backup en un entorno detenido o instalar lector compatible; un binario viejo no debe abrir y reinterpretar datos nuevos.

Estado durable por run: objetivo/contextos, participantes/bindings, tareas y versiones, objeciones, mensajes/intentos, resultados/revisiones, permisos observados, ticket, límites y cierre. Después de compactación se reconstruye desde status; no se depende de recordar un Markdown. Opcionalmente generar checkpoint privado de decisiones con versión y siguiente acción, usando escritura atómica fuera del snapshot congelado. Transcript/export con IDs y tokens privados queda fuera de Git. Los documentos públicos se saneen y no incluyen enlaces de panel ni configuración completa.

## 9. Hitos de implementación y puntos de salida

| Hito | Trabajo y archivos orientativos | Dependencia | Aceptación |
| --- | --- | --- | --- |
| S0 — capacidad/identidad | Prototipo aislado y medición; caller-principal.ts/adaptadores propuestos | Base revisada y alcance autorizado | Dos chats distinguidos; medir metadata MCP de host y secuencia hooks/MCP, compact/fork/reload; decidir si existe binding seguro |
| S1 — paquetes y callers | Manifiesto/launcher/hooks Claude, entrypoint por host, caller-principal.ts; apertura privada del panel | S0 | Caller validado; sin token de control en outputs/logs; canje único; instalación aislada y sockets intactos. Gate antes de S4 |
| S2 — núcleo simétrico | collaboration.ts, runs.ts, routine-ledger.ts, coordination.ts, implementation.ts, mensajes src/dst, migración/fencing | S1 | Tests de ambos iniciadores, ACL, presupuesto, contextos, revisión y leases; datos legacy intactos |
| S3 — transportes y preflight | Adaptadores Codex/Claude, sidecar/binding, bridge.ts, participants.ts, doctor.ts/preflight.ts | S2 | Ida y vuelta con chat existente en ambas direcciones; no se alteran políticas ni se inventan ACKs |
| S4 — tickets/nuevos chats | creation-tickets.ts, adaptadores de creación/receipts, permisos separados y bootstrap | S3 | Repetición idempotente, crash/ACK perdido, binding correcto; fallback honesto donde falta creación comprobable |
| S5a — panel/skills existentes | panel.ts, panel-commands.ts, App.tsx, Implementation.tsx, EN/ES y skills de ambos hosts | S3 | Inicio/control desde cualquiera con chat existente, src/dst correctos y refresh sin perder input |
| S5b — panel de creación | UI de tickets/capacidades/autorización/bind y guías | S4 + S5a | Chat nuevo según capacidad real, sesiones de panel separadas y elección persistente explícita |
| S6 — piloto y entrega | Suites, builds, instalación aislada, pruebas Desktop reales, docs de compatibilidad/uso | S5a/S5b según entrega | Matriz de abajo completada con evidencia propia; límites pendientes claramente expuestos |

Cada hito termina con pruebas y revisión del diff. S0/S1 no migran bases reales. Medir identidad/creación antes de estimar; un gate fallido queda pendiente, con capacidad parcial explícita.

Entrega A: S0–S3 + S5a y piloto de chats existentes, sin esperar creación. Entrega B: S4 + S5b y pilotos de chats nuevos. Separar PRs revisables por contrato y pruebas, conservando regresiones en cada entrega.

## 10. Pruebas que deben existir

### Identidad y permisos

UUID/author/PID falsos en args o metadata no válida; MCP compartido ambiguo; PID reutilizado; registro/socket obsoleto o symlink; cambio de carpeta, inode, rama o sesión; plugin ausente y receptor antiguo; dos nombres iguales; fork sin autoridad; peer diciendo “aprobado”; ticket solicitado sin permiso; ACL de run ajena; grant legacy conservado pero incapaz de crear chats; permiso de creación revocado/expirado; restricciones explícitas hold/refuse que prevalecen. Verificar que diagnósticos no creen/migren estado ni escriban ajustes.

### Núcleo y fallos

Ambos iniciadores con idéntica semántica; CAS obsoleto; dos controllers, takeover y epoch viejo; reserva→socket→ACK perdido; pausa/cancelación/expiry durante entrega; respuesta tardía ocultada según política; replay mismo ID devuelve estado y payload distinto falla; un solo presupuesto compartido; límite no reinicia en recover; contexto cambia e invalida tareas/reviews; barrera conserva contenido oculto; versiones inmutables; autorevisión visible y revisión del otro distinguida; readiness de implementación por hash/base/recibos exactos. No prometer edición bloqueada por un lock inexistente.

### Creación

Repetir request no crea dos chats; caída antes de crear, después del efecto y antes del receipt; resultado pendiente; hostRef viejo o extranjero; 0 y múltiples candidatos; proyecto correcto pero creación ajena sin correlación; modelo indisponible/indeterminado; cambio de modo; ticket caducado/reutilizado; segundo bootstrap; autorización de recepción sin autorización de creación; asistida sin opt-in; cierre de la app; cambio de versión del host. Ningún test debe pasar por sustituir Desktop por CLI.

### UI y packaging

Scope del panel, Origin/CSRF/token, permisos mínimos; comandos human payload vs peer notification; formulario conservado en auto-refresh; SSE caído y vuelta a polling; error parcial de diagnóstico; EN/ES de todos los estados nuevos; navegabilidad teclado/foco; varias pestañas; nuevo puerto y preferencia de idioma según contrato actual; autoopen único/opt-out; contenido no admitido oculto; producción panel-dist corresponde al fuente. Tipos, suite, bundles e instalación en homes aislados. No basta un snapshot del HTML.

Añadir: no hay token de control en resultados MCP; segundo canje falla aunque el primero lo solicite otro navegador; adaptador asistido rechaza operar el panel; panel reabierto no hereda sesión; participante sin ACL intenta control/limits también desde panel de otro host; prompt del hook no persiste; capability filtrada/reusada/ajena se trata según su alcance, sin afirmar autenticación OS no medida.

### Piloto real con las apps

| Origen | Destino | Ensayo |
| --- | --- | --- |
| Codex | Claude existente | Probe, análisis pequeño, contraste y cierre visibles en panel |
| Claude | Codex existente | Mismo protocolo/control, sin instrucción manual de inicio en Codex |
| Codex | Claude nuevo | Creación asistida/nativa según capacidad, binding/permiso, modelo solicitado y colaboración |
| Claude | Codex nuevo | Capacidad real disponible desde ese host o ejecución autorizada; no usar herramienta imaginaria |

Repetir casos con destinatario idle, busy y una herramienta en marcha; reiniciar panel y uno de los hosts; compactar contexto y continuar desde estado durable; conservar presupuestos y no repetir mensajes inciertos. Primero solo lectura. Después implementación opt-in en worktrees separados con autorización específica, captura y review exacta como fase 6; no habilitar escritura por seleccionar un preset.

Para cada ensayo guardar versión/app/OS, principio/fin, acción humana, identidad/binding, ticket/capacidad, intentos, estados antes/después, hash del candidato y capturas saneadas. Separar hechos observados, declaraciones de cada modelo y limitaciones. La prueba positiva de un chat nuevo Claude realizada hoy solo cubre creación asistida y recepción del bridge actual.

## 11. Criterio de entrega y decisiones abiertas

Se podrá anunciar inicio simétrico cuando ambas apps puedan iniciar y controlar una colaboración con un destinatario existente usando identidad verificada y el panel común. La creación completamente automática se anunciará por host/adaptador únicamente al superar sus ensayos reales. Si Claude solo admite apertura asistida, la UI debe decirlo; no etiquetar el producto como totalmente automático.

Queda por comprobar: aislamiento/metadata del MCP Claude; posibilidad de correlación confiable de creación por host; adaptador Claude con admisión y atribución correctas; necesidad de un servicio neutral persistente; capacidad de creación disponible desde cada agente. Son gates del plan, no defectos ya corregidos.

Se descarta como solución principal que Claude envíe texto a Codex para que este se convierta en dueño sin autorización verificable. Un relay solo puede llevar una solicitud durable ya autorizada. Se conserva el desacuerdo debatido sobre autovincular por ventana única: esta propuesta exige correlación de creación independiente o vinculación humana.

Primer paso al retomar: leer este plan, status Git y capacidades instaladas; comprobar base de los cambios previos; empezar S0 aislado. No borrar configuración, no duplicar conversaciones de trabajo y no comenzar S2 antes de resolver identidad.
