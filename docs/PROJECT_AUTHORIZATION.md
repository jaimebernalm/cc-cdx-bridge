# Autorización recordada por proyecto — continuidad de fase 4

## Objetivo y decisiones

Añadir al panel una autorización persistente, revocable y voluntaria para que los chats Codex nuevos reciban respuestas de Claude en colaboraciones gestionadas del proyecto. No cambiar ajustes globales de Claude ni los permisos de ejecución/edición de ninguna app.

- Alcance: carpeta canónica exacta, identificada además por dispositivo/inodo. Los alias por enlace simbólico equivalen; otra carpeta/worktree o una carpeta recreada no heredan permiso.
- Precedencia: `accept`, `hold` y `refuse` explícitos del chat prevalecen. Únicamente `default` puede heredar. Revocar la herencia no revoca el `accept` propio de un chat.
- Elegibilidad: respuesta admitida y correlacionada en una colaboración, propietario Codex y participante Claude verificados en esa misma carpeta. No cubre mensajes ordinarios, análisis sin correlación, participantes arbitrarios ni mensajes de versiones/contextos inválidos.
- No liberar mensajes antiguos al activar/revocar. Solo mensajes admitidos después de la activación; las barreras, pausas, límites y comprobaciones de proceso/proyecto existentes permanecen.
- Persistencia: SQLite privada compartida por receptores, con revisión, actor, fechas, identidad de carpeta y auditoría de acciones humanas. IDs idempotentes y compare-and-swap impiden dobles clics, repeticiones antiguas y pestañas desactualizadas.
- UI: estado visible al preparar colaboración y pantalla de autorizaciones con selector de chat/proyecto, activación confirmada y revocación. Mostrar ajuste propio y compatibilidad del receptor; no prometer herencia en receptores anteriores.
- API: cookie del panel, mismo origen, CSRF y verificación nativa del chat/proyecto. No añadir herramienta de agente que pueda conceder autorización desde texto del participante.

## Secuencia de implementación

1. [x] Almacén de autorizaciones y pruebas de persistencia, alias, aislamiento, recreación, auditoría, idempotencia y CAS.
2. [x] Integrar herencia en recepción, revalidarla antes de entrega nativa y conservar prioridad de ajustes por chat.
3. [x] Exponer capacidad del receptor y API autenticada de consulta/activación/revocación.
4. [x] UI shadcn existente: controles visibles y confirmación del alcance exacto.
5. [x] Pruebas de integración: respuesta real a socket con `default`, revocación, `hold/refuse`, mensaje ordinario, contexto inválido, proyecto distinto y permisos HTTP.
6. [x] Compilar backend/UI, suite fuente y compilada, instalación aislada y actualizar plugin local.
7. [x] Inspección visual de UI real y entrega, conservando autorización de proyecto desactivada hasta elección humana explícita.

## Criterio de aceptación

Un receptor nuevo con `default` puede entregar una respuesta verificada de la colaboración cuando existe autorización vigente para su carpeta. Con permiso revocado, receptor incompatible, ajuste explícito de retención/rechazo, otro proyecto o mensaje no elegible, la herencia no concede acceso. El usuario activa/revoca desde el panel y el estado persiste tras reiniciar. Una revisión recibida sigue siendo una declaración atribuida, nunca consenso validado.

## Estado

Implementación terminada en `feature/phase-4-local-panel` (0.6.1). 127 pruebas y 969 aserciones pasan en fuente y bundles. UI aislada validada de extremo a extremo; receptores reales actualizados manteniendo sus ajustes; panel real validado de extremo a extremo con autorización activada y conservada por elección expresa del usuario. El usuario autorizó publicar/revisar/fusionar la PR de fase 4 y abrir una rama de fase 5. El ensayo real terminó con revisión de Claude recibida, orden consumida una vez, `default` preservado y reservas liberadas. La autorización real queda recordada por petición expresa; no se cambiaron los ajustes propios de los chats ni la recepción de Claude.
