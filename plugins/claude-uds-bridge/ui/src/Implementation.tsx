import { useEffect, useState } from "react";
import { Download, GitBranch, RefreshCw } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
export type Preset = { id: string; title: string; description: string };
export type ImplementationInput = {
  strategy: "files" | "worktrees";
  workspaces: {
    codex: { root: string; paths: string[] };
    claude: { root: string; paths: string[] };
  };
  requiredChecks: string[];
};
export type ImplementationState = {
  plan: {
    baseCommit: string;
    strategy: string;
    isolation: string;
    workspaces: { provider: string; root: string; paths: string[] }[];
    requiredChecks: string[];
  };
  candidate: null | {
    resultId: string;
    version: number;
    contentHash: string;
    contextVersion: number;
    snapshots: {
      provider: string;
      files: { path: string; hash: string | null }[];
    }[];
  };
  checks: {
    name: string;
    command: string;
    exitCode: number;
    summary: string;
    candidateHash: string;
  }[];
};
type Inspection = ImplementationState & {
  ready: boolean;
  reasons: string[];
  integration: null | {
    clean: boolean;
    error: string | null;
    patch: string | null;
  };
};
const lines = (s: string) =>
  s
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
export function ImplementationOptions({
  codexRoot,
  claudeRoot,
  supported,
  onChange,
}: {
  codexRoot: string;
  claudeRoot: string;
  supported: boolean;
  onChange: (v: ImplementationInput | undefined) => void;
}) {
  const [enabled, setEnabled] = useState(false),
    [strategy, setStrategy] = useState<"files" | "worktrees">("files"),
    [rootC, setRootC] = useState(codexRoot),
    [rootL, setRootL] = useState(claudeRoot),
    [scopeC, setScopeC] = useState(""),
    [scopeL, setScopeL] = useState(""),
    [checks, setChecks] = useState("tests");
  useEffect(() => {
    if (!supported) setEnabled(false);
  }, [supported]);
  useEffect(() => {
    setRootC(codexRoot);
    setRootL(claudeRoot);
  }, [codexRoot, claudeRoot]);
  useEffect(
    () =>
      onChange(
        enabled
          ? {
              strategy,
              workspaces: {
                codex: { root: rootC, paths: lines(scopeC) },
                claude: {
                  root: strategy === "files" ? rootC : rootL,
                  paths: lines(scopeL),
                },
              },
              requiredChecks: lines(checks),
            }
          : undefined,
      ),
    [enabled, strategy, rootC, rootL, scopeC, scopeL, checks, onChange],
  );
  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle>Preparar cambios coordinados</CardTitle>
          <Switch
            id="write-contract"
            checked={enabled}
            disabled={!supported}
            onCheckedChange={setEnabled}
          />
        </div>
        <CardDescription>
          <Label htmlFor="write-contract">
            Activar un reparto explícito de archivos y comprobaciones.
          </Label>{" "}
          Elegir un uso por sí solo no habilita escritura.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!supported && (
          <p className="text-xs text-muted-foreground">
            Reabre el receptor actualizado de este chat para configurar
            implementación.
          </p>
        )}
        {enabled && (
          <>
            <div>
              <Label htmlFor="write-strategy">Distribución</Label>
              <NativeSelect
                id="write-strategy"
                className="mt-2 w-full"
                value={strategy}
                onChange={(e) =>
                  setStrategy(e.target.value as "files" | "worktrees")
                }
              >
                <NativeSelectOption value="files">
                  Archivos distintos en una carpeta compartida
                </NativeSelectOption>
                <NativeSelectOption value="worktrees">
                  Worktrees Git separados, ya creados
                </NativeSelectOption>
              </NativeSelect>
            </div>
            <Alert>
              <AlertDescription>
                {strategy === "files"
                  ? "El reparto es un acuerdo: detecta cambios fuera del alcance, pero no bloquea los editores ni demuestra quién escribió cada archivo."
                  : "Los worktrees aíslan físicamente los archivos. Ambos deben existir, estar limpios y compartir repositorio y HEAD. Los agentes conservan sus permisos normales."}
              </AlertDescription>
            </Alert>
            <div className="grid gap-5 sm:grid-cols-2">
              {[
                {
                  name: "Codex",
                  root: rootC,
                  setRoot: setRootC,
                  paths: scopeC,
                  setPaths: setScopeC,
                },
                {
                  name: "Claude",
                  root: strategy === "files" ? rootC : rootL,
                  setRoot: setRootL,
                  paths: scopeL,
                  setPaths: setScopeL,
                },
              ].map((w) => (
                <div key={w.name} className="space-y-3">
                  <Label>{w.name}</Label>
                  <Input
                    aria-label={`Carpeta de escritura ${w.name}`}
                    value={w.root}
                    disabled={strategy === "files" && w.name === "Claude"}
                    onChange={(e) => w.setRoot(e.target.value)}
                    placeholder="Carpeta Git absoluta"
                  />
                  <Textarea
                    aria-label={`Archivos asignados ${w.name}`}
                    rows={3}
                    value={w.paths}
                    onChange={(e) => w.setPaths(e.target.value)}
                    placeholder="archivo.ts o src/ · uno por línea"
                  />
                </div>
              ))}
            </div>
            <div>
              <Label htmlFor="required-checks">Comprobaciones requeridas</Label>
              <Textarea
                id="required-checks"
                className="mt-2"
                rows={2}
                value={checks}
                onChange={(e) => setChecks(e.target.value)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Nombres, uno por línea. Los agentes ejecutan las pruebas y
                registran sus resultados como declaraciones.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              La base se fija al preparar. La integración produce un parche
              comprobado en un índice temporal; aplicar, hacer commit o publicar
              son pasos separados.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
export function ImplementationDetail({
  runId,
  state,
  enabled,
  onWork,
  inspect,
}: {
  runId: string;
  state: ImplementationState;
  enabled: boolean;
  onWork: (work: Record<string, unknown>) => Promise<boolean>;
  inspect: () => Promise<unknown>;
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(state.plan.requiredChecks[0] ?? ""),
    [command, setCommand] = useState(""),
    [exitCode, setExitCode] = useState(0),
    [summary, setSummary] = useState("");
  const candidate = state.candidate;
  useEffect(
    () => setInspection(null),
    [candidate?.version, candidate?.contentHash, state.checks.length],
  );
  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      setInspection((await inspect()) as Inspection);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/runs/${runId}/patch`);
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(
          typeof failure?.error === "string"
            ? failure.error
            : "El servicio local no pudo preparar el parche.",
        );
      }
      // Use the authenticated HTTP attachment: the Desktop browser cannot
      // save blob: downloads. The attachment request revalidates once more.
      const link = document.createElement("a");
      link.href = `/api/v1/runs/${runId}/patch`;
      link.download = `implementation-${runId}.patch`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      // A prior inspection is only an observation; a failed download must not
      // leave its ready badge or link suggesting that the patch is current.
      setInspection(null);
      setError(`No se pudo descargar el parche. ${(e as Error).message}`);
      try {
        setInspection((await inspect()) as Inspection);
      } catch {
        // Preserve the original failure if the local service is unavailable.
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Contrato de implementación</CardTitle>
            <Badge variant="outline">
              {state.plan.strategy === "files"
                ? "Acuerdo de archivos"
                : "Worktrees separados"}
            </Badge>
          </div>
          <CardDescription>
            {state.plan.strategy === "files"
              ? "No hay bloqueos de editor ni autoría técnica verificada."
              : "Archivos separados; los permisos de los agentes siguen aplicándose."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="break-all text-xs text-muted-foreground">
            Base Git: {state.plan.baseCommit}
          </p>
          {state.plan.workspaces.map((w) => (
            <div key={w.provider} className="rounded-md border p-4">
              <p className="font-medium">
                {w.provider === "codex" ? "Codex" : "Claude"}
              </p>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {w.root}
              </p>
              <ul className="mt-3 space-y-1 text-sm">
                {w.paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Candidato y evidencia</CardTitle>
          <CardDescription>
            La captura congela parches, archivos y contexto en una versión.
            Recapturar crea otra versión y exige otra revisión.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {candidate ? (
            <>
              <p className="text-sm">
                Versión {candidate.version} · contexto{" "}
                {candidate.contextVersion}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Hash: {candidate.contentHash}
              </p>
              {candidate.snapshots.map((s) => (
                <p key={s.provider} className="text-sm">
                  {s.provider}:{" "}
                  {s.files
                    .map((f) => f.path + (f.hash ? "" : " (borrado)"))
                    .join(", ") || "Sin cambios"}
                </p>
              ))}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Aún no hay candidato capturado.
            </p>
          )}
          <Button
            variant="outline"
            disabled={!enabled}
            onClick={() =>
              void onWork({ action: "capture", taskId: crypto.randomUUID() })
            }
          >
            <GitBranch />
            Capturar candidato
          </Button>
          <div className="space-y-3">
            {state.plan.requiredChecks.map((check) => {
              const receipt = state.checks
                .filter(
                  (c) =>
                    c.name === check &&
                    c.candidateHash === candidate?.contentHash,
                )
                .at(-1);
              return (
                <div key={check} className="rounded-md bg-muted p-3">
                  <p className="text-sm font-medium">
                    {check} ·{" "}
                    {receipt
                      ? receipt.exitCode === 0
                        ? "Éxito declarado"
                        : "Fallo declarado"
                      : "Falta recibo vigente"}
                  </p>
                  {receipt && (
                    <>
                      <p className="mt-1 break-all text-xs">
                        {receipt.command} · salida {receipt.exitCode}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {receipt.summary}
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {candidate && enabled && (
            <details className="rounded-md border p-4">
              <summary className="cursor-pointer text-sm">
                Registrar una comprobación declarada
              </summary>
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onWork({
                    action: "check",
                    candidateHash: candidate.contentHash,
                    name,
                    command,
                    exitCode,
                    summary,
                  });
                }}
              >
                <NativeSelect
                  aria-label="Nombre de comprobación"
                  className="w-full"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                >
                  {state.plan.requiredChecks.map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {c}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Input
                  aria-label="Comando ejecutado"
                  required
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="Comando que ejecutaste"
                />
                <Input
                  aria-label="Código de salida"
                  type="number"
                  min={-1}
                  max={255}
                  required
                  value={exitCode}
                  onChange={(e) => setExitCode(Number(e.target.value))}
                />
                <Textarea
                  aria-label="Resumen de comprobación"
                  required
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Resultado y límites de la evidencia"
                />
                <p className="text-xs text-muted-foreground">
                  Registrar este recibo no ejecuta ni verifica el comando.
                </p>
                <Button type="submit" size="sm">
                  Guardar recibo
                </Button>
              </form>
            </details>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Preparación de integración</CardTitle>
          <CardDescription>
            Recomprueba archivos, recibos y revisión del otro agente de la
            versión exacta. Busca conflictos sin alterar los checkouts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void recheck()}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} />
            Comprobar integración
          </Button>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {inspection && (
            <>
              <Badge variant={inspection.ready ? "secondary" : "outline"}>
                {inspection.ready
                  ? "Preparado en la última comprobación"
                  : "Pendiente de resolver"}
              </Badge>
              {inspection.reasons.map((r, i) => (
                <p key={i} className="text-sm">
                  {r}
                </p>
              ))}
              {inspection.integration && (
                <p className="text-sm">
                  {inspection.integration.clean
                    ? "Los parches se combinan sobre la base fijada."
                    : "Conflicto al combinar los parches."}
                </p>
              )}
              {inspection.ready && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void download()}
                >
                  <Download />
                  Descargar parche revalidado
                </Button>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Las pruebas y el veredicto de revisión son declaraciones atribuidas.
            Preparar el parche no certifica consenso, no hace commit y no
            publica. La descarga vuelve a comprobar el estado actual.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
