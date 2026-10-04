import { useState } from "react";
import {
  API_BASE_URL,
  analyzeConversation,
  checkHealth,
  completePromise,
  getAnalysis,
  getPromises,
  listAnalyses,
  updatePromise,
  type ApiResult,
  type PromiseItem,
} from "./api";

const SAMPLE_DOCUMENT = `Rahul: I'll send the PPT tomorrow.
Priya: I will review it on Friday.
Amit will prepare the final report next Monday.`;

const DEFAULT_UPDATE = `{
  "status": "pending"
}`;

type Operation =
  | "health"
  | "analyze"
  | "analysis"
  | "promises"
  | "history"
  | "update"
  | "complete";

interface RequestLogItem {
  id: number;
  time: string;
  method: string;
  endpoint: string;
  status: number | null;
  ok: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findPromiseArray(data: unknown): PromiseItem[] {
  if (Array.isArray(data)) return data.filter(isRecord) as PromiseItem[];
  if (!isRecord(data)) return [];

  const possibleArrays = [
    data.promises,
    isRecord(data.data) ? data.data.promises : undefined,
    isRecord(data.analysis) ? data.analysis.promises : undefined,
    data.items,
  ];

  const match = possibleArrays.find(Array.isArray);
  return match ? (match.filter(isRecord) as PromiseItem[]) : [];
}

function findAnalysisId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.analysis_id === "string") return data.analysis_id;
  if (typeof data.id === "string") return data.id;
  if (isRecord(data.data) && typeof data.data.analysis_id === "string") {
    return data.data.analysis_id;
  }
  return undefined;
}

function extractApiError(data: unknown) {
  if (!isRecord(data)) return {};
  const source = isRecord(data.error) ? data.error : data;
  return {
    code: typeof source.code === "string" ? source.code : undefined,
    message:
      typeof source.message === "string"
        ? source.message
        : typeof source.detail === "string"
          ? source.detail
          : undefined,
    requestId:
      typeof source.request_id === "string" ? source.request_id : undefined,
  };
}

function confidenceLabel(confidence: unknown): string {
  if (typeof confidence !== "number") return "—";
  const value = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(value)}%`;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function JsonViewer({
  data,
  emptyMessage = "No response yet.",
}: {
  data: unknown;
  emptyMessage?: string;
}) {
  return (
    <pre className="json-viewer">
      {data === undefined
        ? emptyMessage
        : typeof data === "string"
          ? data
          : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function ResultNotice({ result }: { result?: ApiResult }) {
  if (!result) return null;

  if (result.ok) {
    return (
      <div className="notice notice-success" role="status">
        <strong>Successful API response</strong>
        <span>
          HTTP {result.status} {result.statusText}
        </span>
      </div>
    );
  }

  const error = extractApiError(result.data);
  const title =
    result.status === null
      ? result.errorKind === "cors"
        ? "Network / CORS Error"
        : "Network Error"
      : "Backend / API Error";

  return (
    <div className="notice notice-error" role="alert">
      <strong>{title}</strong>
      <span>
        {result.status === null
          ? "No HTTP response received"
          : `HTTP ${result.status} ${result.statusText}`}
      </span>
      {error.code && <span>Code: {error.code}</span>}
      {error.message && <span>Message: {error.message}</span>}
      {(result.requestId || error.requestId) && (
        <span>Request ID: {result.requestId || error.requestId}</span>
      )}
      {result.errorMessage && <span>{result.errorMessage}</span>}
    </div>
  );
}

function PromiseTable({
  promises,
  onSelect,
}: {
  promises: PromiseItem[];
  onSelect: (id: string) => void;
}) {
  if (!promises.length) {
    return (
      <div className="empty-state">
        No promises to display. Run an analysis or fetch promises by analysis ID.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Owner</th>
            <th>Recipient</th>
            <th>Promise &amp; evidence</th>
            <th>Deadline</th>
            <th>Status</th>
            <th>Confidence</th>
            <th>Verification</th>
          </tr>
        </thead>
        <tbody>
          {promises.map((item, index) => {
            const id =
              typeof item.id === "string"
                ? item.id
                : typeof item.promise_id === "string"
                  ? item.promise_id
                  : "";
            const verified = item.evidence?.verified;
            const status =
              typeof item.status === "string" ? item.status : "unknown";

            return (
              <tr key={id || index}>
                <td>
                  {id ? (
                    <button
                      className="id-button"
                      type="button"
                      title="Use this promise ID in Promise Actions"
                      onClick={() => onSelect(id)}
                    >
                      {id}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{displayValue(item.owner)}</td>
                <td>{displayValue(item.recipient)}</td>
                <td className="promise-cell">
                  <strong>{displayValue(item.promise)}</strong>
                  {item.evidence?.quote && (
                    <q>{String(item.evidence.quote)}</q>
                  )}
                </td>
                <td>{displayValue(item.deadline)}</td>
                <td>
                  <span className={`badge status-${status}`}>
                    {status.replaceAll("_", " ")}
                  </span>
                </td>
                <td>{confidenceLabel(item.confidence)}</td>
                <td>
                  {verified === true
                    ? "✓ Verified"
                    : verified === false
                      ? "✗ Not verified"
                      : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [document, setDocument] = useState(SAMPLE_DOCUMENT);
  const [referenceDate, setReferenceDate] = useState("2026-10-04");
  const [analysisId, setAnalysisId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [promiseId, setPromiseId] = useState("");
  const [updateJson, setUpdateJson] = useState(DEFAULT_UPDATE);
  const [latestResult, setLatestResult] = useState<ApiResult>();
  const [healthResult, setHealthResult] = useState<ApiResult>();
  const [analyzeResult, setAnalyzeResult] = useState<ApiResult>();
  const [historyResult, setHistoryResult] = useState<ApiResult>();
  const [promises, setPromises] = useState<PromiseItem[]>([]);
  const [requestLog, setRequestLog] = useState<RequestLogItem[]>([]);
  const [loading, setLoading] = useState<Partial<Record<Operation, boolean>>>(
    {},
  );
  const [formError, setFormError] = useState("");

  const isBackendOnline = healthResult?.ok === true;
  const healthKnown = Boolean(healthResult);

  async function runOperation(
    operation: Operation,
    callback: () => Promise<ApiResult>,
  ) {
    setLoading((current) => ({ ...current, [operation]: true }));
    setFormError("");

    const result = await callback();
    setLatestResult(result);
    setRequestLog((current) =>
      [
        {
          id: Date.now(),
          time: new Date().toLocaleTimeString(),
          method: result.method,
          endpoint: result.endpoint,
          status: result.status,
          ok: result.ok,
        },
        ...current,
      ].slice(0, 30),
    );
    setLoading((current) => ({ ...current, [operation]: false }));
    return result;
  }

  async function handleHealth() {
    const result = await runOperation("health", checkHealth);
    setHealthResult(result);
  }

  async function handleAnalyze() {
    const result = await runOperation("analyze", () =>
      analyzeConversation(document, referenceDate),
    );
    setAnalyzeResult(result);

    if (result.ok) {
      const newAnalysisId = findAnalysisId(result.data);
      const returnedPromises = findPromiseArray(result.data);
      if (newAnalysisId) setAnalysisId(newAnalysisId);
      setPromises(returnedPromises);
    }
  }

  async function handleGetAnalysis() {
    if (!analysisId.trim()) {
      setFormError("Enter an analysis ID before requesting an analysis.");
      return;
    }
    await runOperation("analysis", () => getAnalysis(analysisId.trim()));
  }

  async function handleGetPromises() {
    if (!analysisId.trim()) {
      setFormError("Enter an analysis ID before requesting promises.");
      return;
    }
    const result = await runOperation("promises", () =>
      getPromises(analysisId.trim(), statusFilter || undefined),
    );
    if (result.ok) setPromises(findPromiseArray(result.data));
  }

  async function handleHistory() {
    const result = await runOperation("history", listAnalyses);
    setHistoryResult(result);
  }

  async function handleUpdate() {
    if (!promiseId.trim()) {
      setFormError("Enter a promise ID before updating a promise.");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(updateJson);
    } catch (error) {
      setFormError(
        `Update JSON is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    await runOperation("update", () =>
      updatePromise(promiseId.trim(), payload),
    );
  }

  async function handleComplete() {
    if (!promiseId.trim()) {
      setFormError("Enter a promise ID before marking it complete.");
      return;
    }
    await runOperation("complete", () => completePromise(promiseId.trim()));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PT</div>
          <div>
            <p className="eyebrow">Every promise, with its receipt.</p>
            <h1>PROMISE TRACKER</h1>
          </div>
        </div>
        <div className="environment">
          <div>
            <span>Backend</span>
            <code>{API_BASE_URL}</code>
          </div>
          <div
            className={`connection ${
              isBackendOnline ? "online" : healthKnown ? "offline" : "unknown"
            }`}
          >
            <span className="status-dot" />
            {isBackendOnline
              ? "Backend Online"
              : healthKnown
                ? "Backend Offline"
                : "Not Checked"}
          </div>
        </div>
      </header>

      <main>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Developer utility</p>
            <h2>Backend Testing Console</h2>
            <p>
              Run real REST requests against FastAPI and inspect every response
              without Postman.
            </p>
          </div>
          <div className="api-label">REST API · Local development</div>
        </div>

        {formError && (
          <div className="form-error" role="alert">
            <strong>Request not sent</strong>
            <span>{formError}</span>
            <button type="button" onClick={() => setFormError("")}>
              Dismiss
            </button>
          </div>
        )}

        <div className="dashboard-grid">
          <div className="primary-column">
            <section className="card">
              <div className="card-header">
                <div className="section-number">01</div>
                <div>
                  <h3>Backend health</h3>
                  <p>Confirm that FastAPI is reachable from this browser.</p>
                </div>
              </div>
              <div className="action-row">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={loading.health}
                  onClick={handleHealth}
                >
                  {loading.health ? "Checking..." : "Check Backend Health"}
                </button>
                {healthResult && (
                  <span className="inline-meta">
                    HTTP {healthResult.status ?? "—"} ·{" "}
                    {healthResult.durationMs} ms
                  </span>
                )}
              </div>
              <ResultNotice result={healthResult} />
              {healthResult && <JsonViewer data={healthResult.data} />}
            </section>

            <section className="card">
              <div className="card-header">
                <div className="section-number">02</div>
                <div>
                  <h3>Analyze conversation</h3>
                  <p>Extract promises from meeting notes or conversation text.</p>
                </div>
              </div>
              <label>
                <span>Conversation / meeting notes</span>
                <textarea
                  rows={8}
                  value={document}
                  placeholder="Paste conversation / meeting notes here..."
                  onChange={(event) => setDocument(event.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  <span>Reference date</span>
                  <input
                    type="date"
                    value={referenceDate}
                    onChange={(event) => setReferenceDate(event.target.value)}
                  />
                </label>
                <button
                  className="button button-primary align-end"
                  type="button"
                  disabled={loading.analyze || !document.trim()}
                  onClick={handleAnalyze}
                >
                  {loading.analyze ? "Analyzing..." : "Analyze Conversation"}
                </button>
              </div>
              <ResultNotice result={analyzeResult} />
              {analyzeResult?.ok && (
                <div className="summary-strip">
                  <div>
                    <span>Analysis ID</span>
                    <strong>{findAnalysisId(analyzeResult.data) || "—"}</strong>
                  </div>
                  <div>
                    <span>Promise count</span>
                    <strong>{findPromiseArray(analyzeResult.data).length}</strong>
                  </div>
                </div>
              )}
              {analyzeResult && <JsonViewer data={analyzeResult.data} />}
            </section>

            <section className="card">
              <div className="card-header">
                <div className="section-number">03</div>
                <div>
                  <h3>Promises</h3>
                  <p>Inspect an analysis and filter its extracted promises.</p>
                </div>
              </div>
              <div className="form-row promises-controls">
                <label className="grow">
                  <span>Analysis ID</span>
                  <input
                    value={analysisId}
                    placeholder="e.g. abc123"
                    onChange={(event) => setAnalysisId(event.target.value)}
                  />
                </label>
                <label>
                  <span>Status filter</span>
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    <option value="pending">Pending</option>
                    <option value="completed">Completed</option>
                    <option value="overdue">Overdue</option>
                    <option value="needs_confirmation">Needs confirmation</option>
                  </select>
                </label>
              </div>
              <div className="action-row">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={loading.analysis}
                  onClick={handleGetAnalysis}
                >
                  {loading.analysis ? "Loading..." : "Get Analysis"}
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={loading.promises}
                  onClick={handleGetPromises}
                >
                  {loading.promises ? "Loading..." : "Get Promises"}
                </button>
                <button
                  className="button button-quiet"
                  type="button"
                  disabled={loading.promises}
                  onClick={handleGetPromises}
                >
                  Refresh
                </button>
              </div>
              <PromiseTable promises={promises} onSelect={setPromiseId} />
            </section>

            <section className="card">
              <div className="card-header">
                <div className="section-number">04</div>
                <div>
                  <h3>Promise actions</h3>
                  <p>Complete a promise or send a custom PATCH payload.</p>
                </div>
              </div>
              <div className="form-row action-id-row">
                <label className="grow">
                  <span>Promise ID</span>
                  <input
                    value={promiseId}
                    placeholder="Select an ID from the table or paste one"
                    onChange={(event) => setPromiseId(event.target.value)}
                  />
                </label>
                <button
                  className="button button-success align-end"
                  type="button"
                  disabled={loading.complete}
                  onClick={handleComplete}
                >
                  {loading.complete ? "Completing..." : "Mark Complete"}
                </button>
              </div>
              <label>
                <span>Update JSON</span>
                <textarea
                  className="code-input"
                  rows={6}
                  value={updateJson}
                  spellCheck={false}
                  onChange={(event) => setUpdateJson(event.target.value)}
                />
              </label>
              <div className="action-row">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={loading.update}
                  onClick={handleUpdate}
                >
                  {loading.update ? "Updating..." : "Update Promise"}
                </button>
                <span className="inline-meta">
                  Payload is parsed and sent exactly as entered.
                </span>
              </div>
            </section>

            <section className="card">
              <div className="card-header">
                <div className="section-number">05</div>
                <div>
                  <h3>Analysis history</h3>
                  <p>View the backend’s complete history response.</p>
                </div>
              </div>
              <button
                className="button button-primary"
                type="button"
                disabled={loading.history}
                onClick={handleHistory}
              >
                {loading.history ? "Loading..." : "Load Analysis History"}
              </button>
              <ResultNotice result={historyResult} />
              {historyResult && <JsonViewer data={historyResult.data} />}
            </section>
          </div>

          <aside className="utility-column">
            <section className="card sticky-card">
              <div className="card-header compact">
                <div className="section-number">06</div>
                <div>
                  <h3>Raw API response</h3>
                  <p>Latest request, unmodified.</p>
                </div>
              </div>
              {latestResult ? (
                <>
                  <dl className="request-meta">
                    <div>
                      <dt>Method</dt>
                      <dd>{latestResult.method}</dd>
                    </div>
                    <div>
                      <dt>Endpoint</dt>
                      <dd>{latestResult.endpoint}</dd>
                    </div>
                    <div>
                      <dt>HTTP status</dt>
                      <dd>
                        {latestResult.status === null
                          ? "No response"
                          : `${latestResult.status} ${latestResult.statusText}`}
                      </dd>
                    </div>
                    <div>
                      <dt>Response time</dt>
                      <dd>{latestResult.durationMs} ms</dd>
                    </div>
                    <div>
                      <dt>Request ID</dt>
                      <dd>{latestResult.requestId || "Not returned"}</dd>
                    </div>
                  </dl>
                  <ResultNotice result={latestResult} />
                  {latestResult.requestBody !== undefined && (
                    <>
                      <h4 className="payload-heading">Request body</h4>
                      <JsonViewer data={latestResult.requestBody} />
                    </>
                  )}
                </>
              ) : (
                <div className="empty-state">
                  Run any request to inspect its response here.
                </div>
              )}
              <h4 className="payload-heading">Response body</h4>
              <JsonViewer data={latestResult?.data} />

              <div className="log-heading">
                <h4>Request log</h4>
                {requestLog.length > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setRequestLog([])}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="request-log">
                {requestLog.length === 0 ? (
                  <p>No requests yet.</p>
                ) : (
                  requestLog.map((item) => (
                    <div className="log-item" key={item.id}>
                      <time>{item.time}</time>
                      <strong>{item.method}</strong>
                      <code title={item.endpoint}>{item.endpoint}</code>
                      <span
                        className={item.ok ? "log-success" : "log-failure"}
                      >
                        {item.status ?? "ERR"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
