# Estado del arte: de la medicina a la orquestación agéntica

> **Revisión preliminar, 18-oct-2026; no es un paper.** Es una lectura rápida de trabajos y entradas de blog recientes,
> con el fin de situar el diseño de subagent-pool. Las cifras de terceros se citan tal como las publican sus autores y
> no están reproducidas por nosotros.

## 1. Por qué un hospital

Un hospital resuelve un problema parecido al de un pipeline de agentes: muchos casos de complejidad muy distinta, varios
especialistas con criterios que pueden contradecirse, un registro obligatorio de lo que se hizo y un momento formal en
que el paciente sale. Cinco piezas del flujo clínico se trasladan a la orquestación de software:

- **Triaje.** Se decide con qué urgencia y con qué complejidad se trata un caso antes de asignar recursos. En subagent-pool,
  el triaje mide cuatro ejes por separado (urgencia, complejidad, etc.), porque la urgencia y la complejidad no son lo mismo.
- **Diagnóstico con falsador.** Antes de tocar nada se formula una hipótesis que pueda refutarse con evidencia. Un diagnóstico
  que no puede fallar no sirve para decidir qué se corrige.
- **Consulta frente a consejo.** Una consulta puntual deja el caso donde está; un consejo reúne varias voces para una decisión
  abierta. Mezclar ambos formatos encarece el proceso sin mejorar la decisión.
- **Expediente.** Todo lo que pasa queda escrito en un documento de caso que se puede auditar después.
- **Alta.** Un caso no se da por cerrado hasta que el proceso se ha seguido, no solo hasta que el código compila.

## 2. Trabajo previo

**MOLT Sinai (Cockroach Labs, 9-oct-2026).** Entrada de blog que describe un pipeline de agentes de código organizado como un
hospital universitario: una enfermera de triaje, *fellows* que diagnostican y operan, *attendings* que revisan, una enfermera
de alta que audita antes de fusionar, y personas que hacen de jefes de medicina. Según la empresa, en cinco meses produjo más
de un millón de líneas, con siete reversiones y unos 84 dólares por issue. No es un trabajo revisado por pares, y su metáfora
es casi la nuestra. Sus lecciones más útiles son: sin un cortacircuitos, un arreglo de una línea dio once vueltas, y una
ventana de revisión gastó 631 de 1.046 dólares en solo tres issues.

**MDAgents (NeurIPS 2024).** Asigna a cada caso médico la estructura de colaboración según su complejidad: un agente solo o un
equipo. Es el equivalente médico de nuestro triaje por complejidad, aplicado a diagnóstico clínico y no a software.

**TriageAgent (Findings of EMNLP 2024).** Agentes clínicos para triaje. Como MDAgents, simula medicina; no aplica la
estructura al desarrollo de software.

**Agent Hospital.** Simulación de un hospital con agentes médicos. Como los anteriores, trabaja sobre medicina y no sobre
software. Sin enlace verificado en esta revisión (ver *Fuentes no verificadas*).

**Fallos en sistemas multiagente.** MAST (NeurIPS 2025) clasifica 14 modos de fallo en tres grupos: diseño, desalineación
entre agentes y verificación. *When Debate Helps* (NeurIPS 2026) sostiene que el debate solo mejora la decisión si hay
propuestas minoritarias correctas y un mecanismo para rescatarlas; votar por mayoría las pierde. El artículo sobre contagio de
complacencia (arXiv 2604.02668) muestra que la sycophancy se propaga entre agentes y favorece un consenso prematuro.

**Orquestación de agentes para software.** Los trabajos sobre sistemas agénticos para ingeniería de software (arXiv 2601.09822),
orquestación verificada (arXiv 2603.11445), SWE-Doctor (arXiv 2607.00990) y RepairAgent (ICSE 2025) describen arquitecturas y
bancos de pruebas; ninguno organiza el flujo como una estructura clínica completa.

**Superpowers (obra/superpowers).** Biblioteca de *skills* con TDD estricto, depuración sistemática y desarrollo con
subagentes. Es la referencia más cercana en metodología. Aún no la hemos analizado en profundidad.

## 3. Cómo se diferencia subagent-pool

| Aspecto | Trabajos previos | subagent-pool |
|---|---|---|
| Dominio | Medicina (MDAgents, TriageAgent, Agent Hospital) o software como metáfora (MOLT Sinai) | Software, con el flujo clínico como estructura de control |
| Diagnóstico | Clasificación o plan | Hipótesis con falsador; la ruta de corrección depende del origen del fallo (implementación, diagnóstico o alcance), según la evidencia |
| Decisiones abiertas | Votación o debate | Consejo con borradores a ciegas y un miembro lateral de otro proveedor (Codex u Opus) |
| Triaje | Una etiqueta de complejidad | Cuatro ejes separados; la urgencia no se confunde con la complejidad |
| Evidencia | Métricas de resultado | Banco A/B en contenedores, publicado con un resultado nulo: empate en resultados y diferencia en el proceso |

## 4. Qué es original y qué falta

**Original, según nuestra lectura:**

- El diagnóstico con falsador y las rutas de corrección según el origen del fallo, decididas por evidencia. MOLT Sinai devuelve
  los planes rechazados al diagnóstico y los fallos de CI al tratamiento, pero no basa la ruta en una hipótesis falsable.
- El consejo con borradores a ciegas y un lateral de otro proveedor.
- El triaje en cuatro ejes separados.
- Un banco A/B publicado con su resultado nulo. Es poco habitual y tiene valor científico.

**Falta para un paper:** casos de tamaño medio con varios archivos, al menos tres corridas por casilla, un subconjunto de un
benchmark reconocido (por ejemplo SWE-bench), ablaciones (con y sin falsador, con y sin consejo) y una comparación con MOLT
Sinai. El formato realista es un paper de workshop. Título provisional: *«El flujo clínico como estructura de control para
agentes de software: estudio de ablación»*. Primero hacen falta más datos y después el texto.

## 5. Ideas adoptadas y candidatas

Estado: **parcial** = ya existe una versión; **candidata** = por implementar.

| Fuente | Hallazgo | Idea para subagent-pool | Estado | Prioridad |
|---|---|---|---|---|
| MOLT Sinai | Sin cortacircuitos, un arreglo de una línea dio 11 vueltas | Tope de coste por caso, usando el registro de costes; los límites de reintentos ya existen | parcial | 1 |
| MOLT Sinai | Traspaso con lectura de vuelta (I-PASS) | Línea `UNDERSTOOD:` al inicio del informe del implementador, para detectar encargos mal leídos antes de gastar | candidata | 2 |
| MOLT Sinai | Auditoría de alta: se revisa que se siguió el proceso, sin repetir la revisión del código | Chequeo barato en el Gate 2: ¿hubo test en rojo?, ¿se dictaminó cada aviso?, ¿hubo revisión? | candidata | 3 |
| MOLT Sinai | Los cambios en tests van en un commit aparte, revisado por separado | Refuerza la regla de integridad de los tests | candidata | — |
| MOLT Sinai | Más de 1.000 líneas obliga a dividir en sub-issues | Regla de descomposición en el plan | candidata | — |
| MOLT Sinai | Registro de precedentes: las decisiones humanas que generalizan se consultan antes de escalar | Conectar el registro de instintos con el escalado | parcial | — |
| MOLT Sinai | Burocracia excesiva: cinco vueltas para corregir un texto; 23 % de palabras sobrantes en los archivos de instrucciones | Medir el tamaño de los prompts y de los archivos de instrucciones | candidata | — |
| MAST (NeurIPS 2025) | 14 modos de fallo en tres grupos | Etiquetar los fallos del banco y del expediente con esa taxonomía | candidata | — |
| When Debate Helps (NeurIPS 2026) | El debate solo ayuda con propuestas minoritarias correctas y un mecanismo de rescate | Sección de minoría obligatoria en el documento de decisiones | candidata | — |
| Contagio de sycophancy (arXiv 2604.02668) | La complacencia se propaga y produce consenso prematuro | Medir el porcentaje de desacuerdo del consejo por ronda; el dato ya se registra en el log del debate | parcial | — |
| Superpowers | TDD estricto en todo, incluidas las funcionalidades | Anotada; no es prioritaria | anotada | — |

**Prioridad sugerida:** (1) tope de coste por caso; (2) línea `UNDERSTOOD:`; (3) auditoría de alta en el Gate 2. Son las
de mejor beneficio frente a su esfuerzo y atacan el riesgo real que mostró MOLT Sinai.

## 6. Fuentes

- Cockroach Labs, «Five months treating bugs like patients» (MOLT Sinai), blog, 9-oct-2026: <https://www.cockroachlabs.com/blog/experiment-running-hospital-code/>
- Discusión de MOLT Sinai en Hacker News: <https://news.ycombinator.com/item?id=50021899>
- MDAgents, NeurIPS 2024: <https://proceedings.neurips.cc/paper_files/paper/2024/file/90d1fc07f46e31387978b88e7e057a31-Paper-Conference.pdf>
- TriageAgent, Findings of EMNLP 2024: <https://aclanthology.org/2024.findings-emnlp.329.pdf>
- MAST, «Why Do Multi-Agent LLM Systems Fail?», NeurIPS 2025: <https://neurips.cc/virtual/2025/poster/121528>
- «When Debate Helps», NeurIPS 2026: <https://neurips.cc/virtual/2026/poster/154779>
- Contagio de sycophancy entre agentes, arXiv 2604.02668: <https://arxiv.org/pdf/2604.02668>
- Sistemas agénticos basados en LLM para ingeniería de software, arXiv 2601.09822: <https://arxiv.org/abs/2601.09822>
- Orquestación multiagente verificada, arXiv 2603.11445: <https://arxiv.org/abs/2603.11445>
- SWE-Doctor, arXiv 2607.00990: <https://arxiv.org/pdf/2607.00990>
- RepairAgent, ICSE 2025: <https://software-lab.org/publications/icse2025_RepairAgent.pdf>
- Superpowers (obra/superpowers): <https://github.com/obra/superpowers>

**Fuentes no verificadas** (no se han podido comprobar en esta revisión; no se enlazan):

- Reseña de Superpowers en kunalganglani.com (responde 403 a la comprobación automática).
- Página de tendencias gittrend.io (responde 403 a la comprobación automática).
- CONSENSAGENT, Findings of ACL 2025 (la URL de vista previa de ACL responde 404).
- Agent Hospital (sin enlace verificado).
- OpenRig, runtime multiagente (solo visto en agregadores; sin verificar).
