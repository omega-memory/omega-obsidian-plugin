/**
 * Embedding engine using Transformers.js running inside a hidden iframe.
 * The iframe isolates ONNX Runtime WASM from Electron's module resolution,
 * which is the proven pattern used by Smart Connections (875K downloads).
 *
 * Architecture: main thread -> postMessage -> iframe (Transformers.js) -> postMessage -> main thread
 * Model: TaylorAI/bge-micro-v2 (384 dims, ~17MB, cached in browser Cache API)
 */

const MODEL_ID = "TaylorAI/bge-micro-v2";
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1";
const IFRAME_ID = "omega-embed-iframe";

// The script that runs inside the iframe
const IFRAME_SCRIPT = `
let pipeline = null;

async function loadModel(modelId, cdnUrl) {
  const { pipeline: createPipeline, env } = await import(cdnUrl);
  env.allowLocalModels = false;
  pipeline = await createPipeline('feature-extraction', modelId);
  return { loaded: true };
}

async function embed(texts) {
  if (!pipeline) throw new Error('Model not loaded');
  const results = [];
  for (const text of texts) {
    const output = await pipeline(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }
  return results;
}

window.addEventListener('message', async (event) => {
  const { method, params, id, iframeId } = event.data;
  if (iframeId !== '${IFRAME_ID}') return;

  try {
    let result;
    if (method === 'load') {
      result = await loadModel(params.modelId, params.cdnUrl);
    } else if (method === 'embed') {
      result = await embed(params.texts);
    }
    window.parent.postMessage({ id, result, iframeId: '${IFRAME_ID}' }, '*');
  } catch (err) {
    window.parent.postMessage({ id, error: err.message, iframeId: '${IFRAME_ID}' }, '*');
  }
});

// Signal ready
window.parent.postMessage({ id: '__ready', result: { ready: true }, iframeId: '${IFRAME_ID}' }, '*');
`;

type PendingMessage = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export class EmbeddingEngine {
  private iframe: HTMLIFrameElement | null = null;
  private messageQueue: Map<string, PendingMessage> = new Map();
  private messageId = 0;
  private _ready = false;
  private _loading = false;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  onProgress: ((progress: { status: string; progress?: number }) => void) | null = null;

  setBasePath(_basePath: string): void {
    // No-op for iframe approach
  }

  async init(): Promise<void> {
    if (this._ready) return;
    this._loading = true;

    this.onProgress?.({ status: "creating iframe", progress: 0 });

    // Create hidden iframe
    const existing = document.getElementById(IFRAME_ID);
    if (existing) existing.remove();

    this.iframe = document.createElement("iframe");
    this.iframe.id = IFRAME_ID;
    this.iframe.style.display = "none";
    document.body.appendChild(this.iframe);

    // Set up message handler
    this.messageHandler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.iframeId !== IFRAME_ID) return;

      const pending = this.messageQueue.get(data.id);
      if (pending) {
        if (data.error) {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.result);
        }
        this.messageQueue.delete(data.id);
      }
    };
    window.addEventListener("message", this.messageHandler);

    // Write the iframe content
    const iframeHtml = `
      <html><body>
        <script type="module">${IFRAME_SCRIPT}</script>
      </body></html>
    `;
    this.iframe.srcdoc = iframeHtml;

    // Wait for iframe to signal ready
    await new Promise<void>((resolve) => {
      const readyHandler = (event: MessageEvent) => {
        if (event.data?.id === "__ready" && event.data?.iframeId === IFRAME_ID) {
          resolve();
        }
      };
      // Also resolve on iframe load as fallback
      this.iframe!.onload = () => setTimeout(resolve, 500);
      window.addEventListener("message", readyHandler, { once: true });
    });

    this.onProgress?.({ status: "downloading model", progress: 10 });

    // Load model inside iframe
    try {
      await this.sendMessage("load", {
        modelId: MODEL_ID,
        cdnUrl: TRANSFORMERS_CDN,
      });
    } catch (e) {
      this._loading = false;
      throw new Error(`Failed to load embedding model: ${e}`);
    }

    this._ready = true;
    this._loading = false;
    this.onProgress?.({ status: "ready", progress: 100 });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this._ready) {
      throw new Error("Embedding engine not initialized. Call init() first.");
    }

    const result = await this.sendMessage("embed", { texts });
    return (result as number[][]).map((vec: number[]) => new Float32Array(vec));
  }

  async embedSingle(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    return results[0];
  }

  private sendMessage(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `omega_${this.messageId++}`;
      this.messageQueue.set(id, { resolve, reject });

      // Timeout after 60 seconds (model download can be slow)
      const timeout = setTimeout(() => {
        if (this.messageQueue.has(id)) {
          this.messageQueue.delete(id);
          reject(new Error(`Message ${method} timed out after 60s`));
        }
      }, 60000);

      const originalResolve = resolve;
      const originalReject = reject;
      this.messageQueue.set(id, {
        resolve: (value: unknown) => { clearTimeout(timeout); originalResolve(value); },
        reject: (error: Error) => { clearTimeout(timeout); originalReject(error); },
      });

      this.iframe?.contentWindow?.postMessage(
        { method, params, id, iframeId: IFRAME_ID },
        "*"
      );
    });
  }

  get isReady(): boolean {
    return this._ready;
  }

  get isLoading(): boolean {
    return this._loading;
  }

  dispose(): void {
    // Clean up iframe
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    // Clean up message handler
    if (this.messageHandler) {
      window.removeEventListener("message", this.messageHandler);
      this.messageHandler = null;
    }
    // Reject pending messages
    for (const [, pending] of this.messageQueue) {
      pending.reject(new Error("Engine disposed"));
    }
    this.messageQueue.clear();
    this._ready = false;
  }
}

// Cosine similarity between two vectors
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
