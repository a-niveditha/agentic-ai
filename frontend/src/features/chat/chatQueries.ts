import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chatKeys, createSession, deleteSession, getMessages, getSessions, renameSession } from "./chatApi";

export function useSessions() {
  return useQuery({ queryKey: chatKeys.sessions, queryFn: getSessions });
}

export function useMessages(sessionId: string) {
  return useQuery({ queryKey: chatKeys.messages(sessionId), queryFn: () => getMessages(sessionId), enabled: Boolean(sessionId) });
}

export function useCreateSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createSession,
    onSuccess: () => client.invalidateQueries({ queryKey: chatKeys.sessions }),
  });
}

export function useRenameSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameSession(id, title),
    onSuccess: () => client.invalidateQueries({ queryKey: chatKeys.sessions }),
  });
}

export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteSession,
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: chatKeys.messages(id) });
      client.invalidateQueries({ queryKey: chatKeys.sessions });
    },
  });
}
