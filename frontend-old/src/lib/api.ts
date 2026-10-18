export const BACKEND_BASE = 'http://localhost:5000';
export const AGENT_BASE = 'http://localhost:5000';

export async function fetchHealth() {
  try {
    const res = await fetch(`${BACKEND_BASE}/api/health`).then((r) => r.json()).catch(() => null);
    return { backend: res };
  } catch {
    return { backend: null };
  }
}

export async function ingestDocument(text: string, filename: string) {
  const res = await fetch(`${BACKEND_BASE}/api/rag/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, filename }),
  });
  return res.json();
}

export async function appendCustomTool(name: string, description: string, outputText: string) {
  const res = await fetch(`${BACKEND_BASE}/api/tools/append`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, outputText }),
  });
  return res.json();
}

export async function fetchTools() {
  const res = await fetch(`${BACKEND_BASE}/api/tools`);
  return res.json();
}

export async function callMcpRpc(method: string, params?: any) {
  const res = await fetch(`${BACKEND_BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  return res.json();
}
