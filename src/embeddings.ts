const MODEL_ID = "TaylorAI/bge-micro-v2";

// Dynamic import type for Transformers.js
type Pipeline = (input: string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array }[]>;

export class EmbeddingEngine {
  private pipeline: Pipeline | null = null;
  private loading = false;
  private loadPromise: Promise<void> | null = null;

  onProgress: ((progress: { status: string; progress?: number }) => void) | null = null;

  async init(): Promise<void> {
    if (this.pipeline) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loading = true;
    this.loadPromise = this._loadModel();
    await this.loadPromise;
    this.loading = false;
  }

  private async _loadModel(): Promise<void> {
    // Dynamic import to avoid bundling Transformers.js at compile time
    const { pipeline, env } = await import("@huggingface/transformers");

    // Disable local model check (always download from hub)
    env.allowLocalModels = false;

    // Use WASM backend (most compatible, works on all platforms)
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
    }

    this.onProgress?.({ status: "downloading", progress: 0 });

    this.pipeline = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "fp32",
      device: "wasm",
      progress_callback: (event: { status: string; progress?: number }) => {
        this.onProgress?.(event);
      },
    }) as unknown as Pipeline;

    this.onProgress?.({ status: "ready", progress: 100 });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.pipeline) {
      throw new Error("Embedding engine not initialized. Call init() first.");
    }

    const results: Float32Array[] = [];

    // Process in batches of 8 to avoid memory issues
    const batchSize = 8;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const output = await this.pipeline(batch, {
        pooling: "mean",
        normalize: true,
      });

      for (const item of output) {
        results.push(new Float32Array(item.data));
      }
    }

    return results;
  }

  async embedSingle(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    return results[0];
  }

  get isReady(): boolean {
    return this.pipeline !== null;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  dispose(): void {
    this.pipeline = null;
    this.loadPromise = null;
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
