import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  CheckCircle2,
  CirclePlay,
  ExternalLink,
  FileImage,
  FolderOpen,
  Gauge,
  Globe2,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import logo from "./assets/vectorizer-ai-logo.svg";
import "./App.css";

type OutputFormat = "svg" | "pdf" | "eps" | "dxf" | "png";
type Mode = "production" | "preview" | "test" | "test_preview";
type JobStatus = "queued" | "running" | "done" | "error";

interface ExtraParam {
  key: string;
  value: string;
}

interface AppSettings {
  apiUrl: string;
  apiId: string;
  outputDir?: string | null;
  outputFormat: OutputFormat;
  mode: Mode;
  retainForReview: boolean;
  retentionDays: number;
  maxPixels?: number | null;
  overwrite: boolean;
  extraParams: ExtraParam[];
}

interface SavedCredentialStatus {
  apiId: string;
  hasSecret: boolean;
}

interface FileEntry {
  path: string;
  name: string;
  size: number;
  extension: string;
}

interface VectorizeResult {
  outputPath: string;
  imageToken?: string | null;
  receipt?: string | null;
  creditsCharged?: string | null;
  creditsCalculated?: string | null;
  reviewUrl?: string | null;
}

interface Job extends FileEntry {
  id: string;
  status: JobStatus;
  message?: string;
  result?: VectorizeResult;
}

interface AccountStatusResponse {
  rawJson: Record<string, unknown>;
}

const formats: OutputFormat[] = ["svg", "pdf", "eps", "dxf", "png"];
const modes: Array<{ value: Mode; label: string }> = [
  { value: "production", label: "Production" },
  { value: "preview", label: "Preview" },
  { value: "test", label: "Test" },
  { value: "test_preview", label: "Test preview" },
];

const defaultSettings: AppSettings = {
  apiUrl: "https://api.vectorizer.ai/api/v1",
  apiId: "",
  outputDir: null,
  outputFormat: "svg",
  mode: "production",
  retainForReview: true,
  retentionDays: 1,
  maxPixels: null,
  overwrite: false,
  extraParams: [],
};

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Error";
  }
}

function compactJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function makeRequest(settings: AppSettings, apiSecret: string, useSavedSecret: boolean, job: Job) {
  return {
    auth: {
      apiId: settings.apiId,
      apiSecret: apiSecret.trim() || null,
      useSavedSecret,
    },
    apiUrl: settings.apiUrl,
    inputPath: job.path,
    outputDir: settings.outputDir ?? "",
    outputFormat: settings.outputFormat,
    mode: settings.mode,
    retainForReview: settings.retainForReview,
    retentionDays: settings.retentionDays,
    maxPixels: settings.maxPixels || null,
    overwrite: settings.overwrite,
    extraParams: settings.extraParams.filter((param) => param.key.trim()),
  };
}

function mergeJobs(existing: Job[], incoming: FileEntry[]): Job[] {
  const seen = new Set(existing.map((job) => job.path));
  const next = [...existing];
  for (const file of incoming) {
    if (!seen.has(file.path)) {
      next.push({
        ...file,
        id: file.path,
        status: "queued",
      });
      seen.add(file.path);
    }
  }
  return next;
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apiSecret, setApiSecret] = useState("");
  const [rememberCredentials, setRememberCredentials] = useState(true);
  const [savedCredentials, setSavedCredentials] = useState<SavedCredentialStatus>({ apiId: "", hasSecret: false });
  const [useSavedSecret, setUseSavedSecret] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [accountJson, setAccountJson] = useState<string | null>(null);

  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const doneCount = jobs.filter((job) => job.status === "done").length;
  const errorCount = jobs.filter((job) => job.status === "error").length;
  const totalCredits = useMemo(() => {
    const total = jobs.reduce((sum, job) => {
      const charged = Number(job.result?.creditsCharged ?? 0);
      return Number.isFinite(charged) ? sum + charged : sum;
    }, 0);
    return total > 0 ? total.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : "0";
  }, [jobs]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!isTauriRuntime) return;
      try {
        const [loadedSettings, status] = await Promise.all([
          invoke<AppSettings>("load_settings"),
          invoke<SavedCredentialStatus>("saved_credentials_status"),
        ]);
        if (!mounted) return;
        setSettings({ ...defaultSettings, ...loadedSettings });
        setSavedCredentials(status);
        if (status.apiId && !loadedSettings.apiId) {
          setSettings((current) => ({ ...current, apiId: status.apiId }));
        }
        setUseSavedSecret(status.hasSecret);
      } catch (error) {
        setNotice(String(error));
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    async function listenForDrops() {
      if (!isTauriRuntime) return;
      unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[] };
        if (payload.type === "drop" && payload.paths?.length) {
          addPaths(payload.paths);
        }
      });
    }
    listenForDrops().catch((error) => {
      if (!disposed) setNotice(String(error));
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function persistSettings(nextSettings = settings) {
    await invoke("save_settings", { settings: nextSettings });
  }

  async function refreshSavedCredentialStatus() {
    const status = await invoke<SavedCredentialStatus>("saved_credentials_status");
    setSavedCredentials(status);
    setUseSavedSecret(status.hasSecret);
  }

  async function addPaths(paths: string[]) {
    setNotice(null);
    try {
      const files = await invoke<FileEntry[]>("collect_images", { paths });
      if (!files.length) {
        setNotice("No supported raster images were found.");
        return;
      }
      setJobs((current) => mergeJobs(current, files));
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function chooseFiles() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Add images",
      filters: [
        {
          name: "Raster images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
        },
      ],
    });
    if (Array.isArray(selected)) await addPaths(selected);
    else if (selected) await addPaths([selected]);
  }

  async function chooseFolder() {
    const selected = await open({
      multiple: true,
      directory: true,
      recursive: true,
      title: "Add folder",
    });
    if (Array.isArray(selected)) await addPaths(selected);
    else if (selected) await addPaths([selected]);
  }

  async function chooseOutputDir() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose output folder",
    });
    if (typeof selected === "string") {
      const next = { ...settings, outputDir: selected };
      setSettings(next);
      await persistSettings(next);
    }
  }

  async function saveCredentialChoice() {
    setNotice(null);
    try {
      const status = await invoke<SavedCredentialStatus>("save_credentials", {
        apiId: settings.apiId,
        apiSecret,
      });
      setSavedCredentials(status);
      setUseSavedSecret(true);
      setApiSecret("");
      setNotice("Credentials saved to the OS credential store.");
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function clearCredentials() {
    setNotice(null);
    try {
      const status = await invoke<SavedCredentialStatus>("clear_saved_credentials");
      setSavedCredentials(status);
      setUseSavedSecret(false);
      setNotice("Saved credentials cleared.");
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function checkAccount() {
    setNotice(null);
    setAccountJson(null);
    try {
      const response = await invoke<AccountStatusResponse>("account_status", {
        request: {
          auth: {
            apiId: settings.apiId,
            apiSecret: apiSecret.trim() || null,
            useSavedSecret,
          },
          apiUrl: settings.apiUrl,
        },
      });
      setAccountJson(compactJson(response.rawJson));
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function runQueue() {
    if (isRunning) return;
    setNotice(null);
    setAccountJson(null);
    if (!settings.outputDir) {
      setNotice("Choose an output folder before running the queue.");
      return;
    }
    if (!settings.apiId.trim()) {
      setNotice("Enter your Vectorizer.AI API Id.");
      return;
    }
    if (!apiSecret.trim() && !useSavedSecret) {
      setNotice("Enter your API Secret or use the saved API Secret.");
      return;
    }
    const runnable = jobs.filter((job) => job.status !== "done");
    if (!runnable.length) {
      setNotice("There are no queued jobs to run.");
      return;
    }
    setIsRunning(true);
    try {
      await persistSettings(settings);
      let savedSecretForThisRun = useSavedSecret;
      if (rememberCredentials && apiSecret.trim()) {
        await invoke("save_credentials", {
          apiId: settings.apiId,
          apiSecret,
        });
        await refreshSavedCredentialStatus();
        savedSecretForThisRun = true;
      }
      for (const job of runnable) {
        setJobs((current) =>
          current.map((item) =>
            item.id === job.id ? { ...item, status: "running", message: "Uploading and vectorizing..." } : item,
          ),
        );
        try {
          const result = await invoke<VectorizeResult>("vectorize_file", {
            request: makeRequest(settings, apiSecret, savedSecretForThisRun, job),
          });
          setJobs((current) =>
            current.map((item) =>
              item.id === job.id
                ? {
                    ...item,
                    status: "done",
                    message: "Saved",
                    result,
                  }
                : item,
            ),
          );
        } catch (error) {
          setJobs((current) =>
            current.map((item) =>
              item.id === job.id
                ? {
                    ...item,
                    status: "error",
                    message: String(error),
                  }
                : item,
            ),
          );
        }
      }
      if (rememberCredentials && apiSecret.trim()) {
        setApiSecret("");
      }
    } finally {
      setIsRunning(false);
    }
  }

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function retryFailed() {
    setJobs((current) =>
      current.map((job) => (job.status === "error" ? { ...job, status: "queued", message: undefined } : job)),
    );
  }

  function clearDone() {
    setJobs((current) => current.filter((job) => job.status !== "done"));
  }

  function removeJob(id: string) {
    setJobs((current) => current.filter((job) => job.id !== id));
  }

  function addParam() {
    updateSettings({ extraParams: [...settings.extraParams, { key: "", value: "" }] });
  }

  function updateParam(index: number, patch: Partial<ExtraParam>) {
    const next = settings.extraParams.map((param, i) => (i === index ? { ...param, ...patch } : param));
    updateSettings({ extraParams: next });
  }

  function removeParam(index: number) {
    updateSettings({ extraParams: settings.extraParams.filter((_, i) => i !== index) });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img src={logo} alt="Vectorizer.AI" />
          <div>
            <h1>Vectorizer.AI Desktop</h1>
            <p>Batch vectorization workbench</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="ghost-button" onClick={() => openUrl("https://vectorizer.ai/api/documentation")}>
            <Globe2 size={17} />
            Docs
          </button>
          <button className="ghost-button" onClick={() => openUrl("https://vectorizer.ai/account")}>
            <ExternalLink size={17} />
            Account
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <div className="panel-title">
              <FileImage size={18} />
              Inputs
            </div>
            <div className="drop-zone">
              <FileImage size={28} />
              <strong>Drop files or folders</strong>
              <span>PNG, JPG, WebP, GIF, BMP, and TIFF</span>
            </div>
            <div className="button-row">
              <button onClick={chooseFiles}>
                <Plus size={17} />
                Add images
              </button>
              <button onClick={chooseFolder}>
                <FolderOpen size={17} />
                Add folder
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <KeyRound size={18} />
              Credentials
            </div>
            <label>
              API Id
              <input
                value={settings.apiId}
                onChange={(event) => updateSettings({ apiId: event.currentTarget.value })}
                placeholder="API Id"
              />
            </label>
            <label>
              API Secret
              <input
                value={apiSecret}
                type="password"
                onChange={(event) => setApiSecret(event.currentTarget.value)}
                placeholder={savedCredentials.hasSecret ? "Saved secret available" : "API Secret"}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={useSavedSecret}
                disabled={!savedCredentials.hasSecret}
                onChange={(event) => setUseSavedSecret(event.currentTarget.checked)}
              />
              Use saved API Secret
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={rememberCredentials}
                onChange={(event) => setRememberCredentials(event.currentTarget.checked)}
              />
              Save secret after a successful run
            </label>
            <div className="button-row">
              <button onClick={saveCredentialChoice}>
                <Save size={17} />
                Save
              </button>
              <button className="ghost-button" onClick={clearCredentials}>
                <Trash2 size={17} />
                Clear
              </button>
            </div>
            <button className="wide ghost-button" onClick={checkAccount}>
              <Gauge size={17} />
              Check account
            </button>
          </section>

          <section className="panel">
            <div className="panel-title">
              <FolderOpen size={18} />
              Output
            </div>
            <label>
              Folder
              <button className="path-button" onClick={chooseOutputDir}>
                {settings.outputDir || "Choose output folder"}
              </button>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={settings.overwrite}
                onChange={(event) => updateSettings({ overwrite: event.currentTarget.checked })}
              />
              Overwrite existing files
            </label>
          </section>
        </aside>

        <section className="main-panel">
          <div className="toolbar">
            <div className="metric-row">
              <span>{jobs.length} files</span>
              <span>{queuedCount} queued</span>
              <span>{doneCount} done</span>
              <span>{errorCount} errors</span>
              <span>{totalCredits} credits</span>
            </div>
            <div className="toolbar-actions">
              <button className="ghost-button" onClick={retryFailed} disabled={!errorCount || isRunning}>
                <RotateCcw size={17} />
                Retry errors
              </button>
              <button className="ghost-button" onClick={clearDone} disabled={!doneCount || isRunning}>
                <Trash2 size={17} />
                Clear done
              </button>
              <button className="run-button" onClick={runQueue} disabled={isRunning || !jobs.length}>
                {isRunning ? <Loader2 className="spin" size={18} /> : <CirclePlay size={18} />}
                Run queue
              </button>
            </div>
          </div>

          {notice && (
            <div className="notice">
              <AlertCircle size={18} />
              {notice}
            </div>
          )}

          {accountJson && (
            <div className="account-result">
              <div className="panel-title">
                <CheckCircle2 size={18} />
                Account status
              </div>
              <pre>{accountJson}</pre>
            </div>
          )}

          <div className="settings-band">
            <div>
              <span className="field-label">Format</span>
              <div className="segmented">
                {formats.map((format) => (
                  <button
                    key={format}
                    className={settings.outputFormat === format ? "active" : ""}
                    onClick={() => updateSettings({ outputFormat: format })}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label">Mode</span>
              <div className="segmented mode">
                {modes.map((mode) => (
                  <button
                    key={mode.value}
                    className={settings.mode === mode.value ? "active" : ""}
                    onClick={() => updateSettings({ mode: mode.value })}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="number-field">
              Retention days
              <input
                type="number"
                min={1}
                max={30}
                disabled={!settings.retainForReview}
                value={settings.retentionDays}
                onChange={(event) => updateSettings({ retentionDays: Number(event.currentTarget.value) || 1 })}
              />
            </label>
            <label className="check-row compact">
              <input
                type="checkbox"
                checked={settings.retainForReview}
                onChange={(event) => updateSettings({ retainForReview: event.currentTarget.checked })}
              />
              Review links
            </label>
          </div>

          <details className="advanced">
            <summary>
              <Settings2 size={17} />
              Advanced request fields
            </summary>
            <div className="advanced-grid">
              <label>
                API URL
                <input
                  value={settings.apiUrl}
                  onChange={(event) => updateSettings({ apiUrl: event.currentTarget.value })}
                />
              </label>
              <label>
                Max pixels
                <input
                  type="number"
                  min={0}
                  value={settings.maxPixels ?? ""}
                  placeholder="No limit"
                  onChange={(event) =>
                    updateSettings({
                      maxPixels: event.currentTarget.value ? Number(event.currentTarget.value) : null,
                    })
                  }
                />
              </label>
            </div>
            <div className="param-list">
              {settings.extraParams.map((param, index) => (
                <div className="param-row" key={index}>
                  <input
                    value={param.key}
                    onChange={(event) => updateParam(index, { key: event.currentTarget.value })}
                    placeholder="literal.form.field"
                  />
                  <input
                    value={param.value}
                    onChange={(event) => updateParam(index, { value: event.currentTarget.value })}
                    placeholder="value"
                  />
                  <button className="icon-button" onClick={() => removeParam(index)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button className="ghost-button" onClick={addParam}>
                <Plus size={17} />
                Add field
              </button>
            </div>
          </details>

          <div className="job-list">
            {jobs.length === 0 ? (
              <div className="empty-state">
                <FileImage size={40} />
                <strong>No images queued</strong>
                <span>Add images or drop a folder to start a batch.</span>
              </div>
            ) : (
              jobs.map((job) => (
                <article className={`job-row ${job.status}`} key={job.id}>
                  <div className="job-icon">
                    {job.status === "running" ? (
                      <Loader2 className="spin" size={22} />
                    ) : job.status === "done" ? (
                      <CheckCircle2 size={22} />
                    ) : job.status === "error" ? (
                      <AlertCircle size={22} />
                    ) : (
                      <FileImage size={22} />
                    )}
                  </div>
                  <div className="job-body">
                    <div className="job-topline">
                      <strong>{job.name}</strong>
                      <span>{formatSize(job.size)}</span>
                      <span>{job.extension.toUpperCase()}</span>
                      <span className={`status ${job.status}`}>{statusLabel(job.status)}</span>
                    </div>
                    <div className="path-line">{job.path}</div>
                    {job.message && <div className="message-line">{job.message}</div>}
                    {job.result && (
                      <div className="result-line">
                        <span>{job.result.outputPath}</span>
                        {job.result.creditsCharged && <span>{job.result.creditsCharged} credits</span>}
                        {job.result.imageToken && <span>token {job.result.imageToken}</span>}
                      </div>
                    )}
                  </div>
                  <div className="job-actions">
                    {job.result?.outputPath && (
                      <>
                        <button className="icon-button" title="Open output" onClick={() => openPath(job.result!.outputPath)}>
                          <ExternalLink size={17} />
                        </button>
                        <button
                          className="icon-button"
                          title="Reveal output"
                          onClick={() => revealItemInDir(job.result!.outputPath)}
                        >
                          <FolderOpen size={17} />
                        </button>
                      </>
                    )}
                    {job.result?.reviewUrl && (
                      <button className="icon-button" title="Review on Vectorizer.AI" onClick={() => openUrl(job.result!.reviewUrl!)}>
                        <Link2 size={17} />
                      </button>
                    )}
                    {!isRunning && (
                      <button className="icon-button" title="Remove" onClick={() => removeJob(job.id)}>
                        <Trash2 size={17} />
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
