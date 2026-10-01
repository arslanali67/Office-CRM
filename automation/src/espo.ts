// Minimal EspoCRM REST client (API-key user, minimal role).

export class Espo {
  private base: string;
  private apiKey: string;

  constructor(base: string, apiKey: string) {
    this.base = base;
    this.apiKey = apiKey;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/api/v1/${path}`, {
      method,
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Espo ${method} ${path} -> ${res.status} ${res.headers.get('x-status-reason') ?? ''} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  get = <T = any>(path: string) => this.req<T>('GET', path);
  post = <T = any>(path: string, body: unknown) => this.req<T>('POST', path, body);
  put = <T = any>(path: string, body: unknown) => this.req<T>('PUT', path, body);

  async list<T = any>(entity: string, params: Record<string, string> = {}): Promise<T[]> {
    const q = new URLSearchParams({ maxSize: '200', ...params });
    return (await this.get<{ list: T[] }>(`${entity}?${q}`)).list;
  }
}
