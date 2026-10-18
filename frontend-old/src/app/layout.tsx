import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentic AI Monorepo | TypeScript LangChain RAG & MCP Platform',
  description: 'Production-grade modular monorepo showcasing LangChain TS Agent, RAG vector retrieval, Template MCP Server, and SSE/WS dual streaming.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#07090e] text-slate-100 min-h-screen selection:bg-cyan-500/30 selection:text-cyan-200">
        {children}
      </body>
    </html>
  );
}
