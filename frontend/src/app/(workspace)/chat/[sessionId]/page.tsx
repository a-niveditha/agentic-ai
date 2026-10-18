import { ChatWorkspace } from "@/features/chat/ChatWorkspace";

export default function SessionPage({ params }: { params: { sessionId: string } }) {
  const { sessionId } = params;
  return <ChatWorkspace sessionId={sessionId} />;
}
