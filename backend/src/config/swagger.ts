import type { Express } from 'express';
import { API_BASE } from './api.js';
import swaggerUi from 'swagger-ui-express';

const bearer = [{ bearerAuth: [] }];
const json = (schema: object) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const err = (description: string) => ({ description, content: json(ref('Error')) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Agentic AI Backend',
    version: '1.0.0',
    description:
      'RAG + tool-using chatbot API. Chat replies stream as Server-Sent Events (or over a WebSocket at /api/v1/ws). ' +
      'Every route except /health, /ready and /auth/signup|login needs `Authorization: Bearer <token>`. ' +
      'Event types: start, token, tool_start, tool_end, citation, error, done.',
  },
  servers: [{ url: API_BASE, description: 'Version 1 of the API' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, requestId: { type: 'string' } } },
      Citation: { type: 'object', properties: { title: { type: 'string' }, source: { type: 'string' }, content: { type: 'string' }, sourceId: { type: 'string' }, url: { type: 'string' }, page: { type: 'integer', description: 'PDF page (1-based)' }, section: { type: 'string', description: 'Heading path, e.g. "Guide > Install"' } } },
      Document: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }, filename: { type: 'string' }, mimeType: { type: 'string' }, sourceUrl: { type: 'string', nullable: true },
          status: { type: 'string', enum: ['processing', 'ready', 'failed'] }, errorMessage: { type: 'string', nullable: true },
          chunksCount: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Session: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, title: { type: 'string' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } } },
    },
  },
  paths: {
    '/health': { get: { tags: ['Health'], summary: 'Liveness', responses: { '200': { description: 'Process is up' } } } },
    '/ready': {
      get: {
        tags: ['Health'], summary: 'Readiness with per-component status (up | degraded | down)',
        responses: { '200': { description: 'Serving (possibly degraded)' }, '503': { description: 'Database unavailable' } },
      },
    },
    '/auth/signup': {
      post: {
        tags: ['Auth'], summary: 'Create an account',
        requestBody: { required: true, content: json({ type: 'object', required: ['email', 'password', 'name'], properties: { email: { type: 'string' }, password: { type: 'string', minLength: 8 }, name: { type: 'string' } } }) },
        responses: { '201': { description: 'Account created; returns user and token' }, '400': err('Validation error'), '409': err('Email already registered'), '429': err('Rate limited') },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Log in',
        requestBody: { required: true, content: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } }) },
        responses: { '200': { description: 'Returns user and token' }, '401': err('Invalid credentials'), '429': err('Rate limited') },
      },
    },
    '/auth/me': { get: { tags: ['Auth'], security: bearer, summary: 'Current user', responses: { '200': { description: 'OK' }, '401': err('Unauthorized') } } },
    '/auth/stream-ticket': {
      post: {
        tags: ['Auth'], security: bearer, summary: 'Mint a single-use ticket (~60s) for EventSource / WebSocket connections',
        requestBody: { content: json({ type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } } }) },
        responses: { '200': { description: '{ ticket, expiresInSeconds }' }, '404': err('Session not found') },
      },
    },
    '/chat/sessions': {
      get: { tags: ['Chat'], security: bearer, summary: 'List your sessions', responses: { '200': { description: 'OK' } } },
      post: { tags: ['Chat'], security: bearer, summary: 'Create a session', requestBody: { content: json({ type: 'object', properties: { title: { type: 'string' } } }) }, responses: { '201': { description: 'Created' } } },
    },
    '/chat/sessions/{id}': {
      patch: { tags: ['Chat'], security: bearer, summary: 'Rename a session', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': err('Not found') } },
      delete: { tags: ['Chat'], security: bearer, summary: 'Delete a session', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': err('Not found') } },
    },
    '/chat/sessions/{id}/messages': {
      get: { tags: ['Chat'], security: bearer, summary: 'Message history', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': err('Not found') } },
      post: {
        tags: ['Chat'], security: bearer, summary: 'Send a message; the reply streams as SSE', parameters: [idParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['text'], properties: { text: { type: 'string' } } }) },
        responses: { '200': { description: 'text/event-stream of start/token/tool_start/tool_end/citation/error/done' }, '404': err('Not found'), '409': err('A reply is already being generated'), '429': err('Rate limited') },
      },
    },
    '/chat/sessions/{id}/stream': {
      get: {
        tags: ['Chat'], summary: 'EventSource variant: authenticates with ?ticket= instead of a header',
        parameters: [idParam, { name: 'ticket', in: 'query', required: true, schema: { type: 'string' } }, { name: 'text', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'text/event-stream' }, '401': err('Invalid, expired or reused ticket') },
      },
    },
    '/documents': {
      get: { tags: ['Documents'], security: bearer, summary: 'List your documents', responses: { '200': { description: 'OK' } } },
      post: {
        tags: ['Documents'], security: bearer,
        summary: 'Add a document: multipart `file` (txt, md, pdf, docx, html, csv, json), or JSON { text, title? } or { url }',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } },
            'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } } } },
          },
        },
        responses: {
          '202': { description: 'Accepted: the document exists with status `processing` and is indexed in the background. Poll the Location header (GET /documents/{id}) until status is `ready` or `failed`.', content: json({ type: 'object', properties: { document: ref('Document') } }) },
          '400': err('Bad input / blocked URL'), '403': err('Document quota exceeded'), '409': err('Identical content already exists (code duplicate_document; body has duplicateOf and document)'),
          '413': err('Too large'), '415': err('Unsupported type'), '422': err('Empty, corrupt or mismatched file'),
          '503': err('Indexing queue full (code queue_full, Retry-After set)'),
        },
      },
    },
    '/documents/{id}': {
      get: { tags: ['Documents'], security: bearer, summary: 'Get one document', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': err('Not found') } },
      delete: { tags: ['Documents'], security: bearer, summary: 'Delete a document and its vectors', parameters: [idParam], responses: { '200': { description: 'OK' }, '404': err('Not found'), '503': err('Vector store unavailable; nothing deleted') } },
    },
    '/documents/{id}/retry': { post: { tags: ['Documents'], security: bearer, summary: 'Re-run indexing from the stored text (background; poll the document)', parameters: [idParam], responses: { '202': { description: 'Accepted; status is `processing` again', content: json({ type: 'object', properties: { document: ref('Document') } }) }, '404': err('Not found'), '409': err('Original text unavailable, or already being processed') } } },
    '/rag/query': {
      post: {
        tags: ['RAG'], security: bearer, summary: 'Stand-alone grounded answer with citations (JSON, or SSE when Accept: text/event-stream)',
        requestBody: { required: true, content: json({ type: 'object', required: ['question'], properties: { question: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 10 } } }) },
        responses: { '200': { description: '{ status, answer, citations }' }, '503': err('Knowledge base unavailable') },
      },
    },
  },
};

export function setupSwagger(app: Express) {
  app.use(`${API_BASE}/docs`, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get(`${API_BASE}/docs-json`, (_req, res) => res.json(swaggerSpec));
}
